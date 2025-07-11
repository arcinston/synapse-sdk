/**
 * Real implementation of the StorageService interface
 *
 * This service handles:
 * - Storage provider selection and management
 * - Proof set creation and selection
 * - File uploads with PDP (Proof of Data Possession)
 * - File downloads with verification
 */

import type { ethers } from 'ethers'
import type {
  StorageServiceOptions,
  StorageCreationCallbacks,
  ApprovedProviderInfo,
  EnhancedProofSetInfo,
  DownloadOptions,
  PreflightInfo,
  UploadCallbacks,
  UploadResult,
  RootData,
  CommP
} from '../types.js'
import type { Synapse } from '../synapse.js'
import type { PandoraService } from '../pandora/service.js'
import { PDPServer } from '../pdp/server.js'
import { PDPAuthHelper } from '../pdp/auth.js'
import { createError } from '../utils/index.js'
import { SIZE_CONSTANTS, TIMING_CONSTANTS } from '../utils/constants.js'

export class StorageService {
  private readonly _synapse: Synapse
  private readonly _provider: ApprovedProviderInfo
  private readonly _pdpServer: PDPServer
  private readonly _pandoraService: PandoraService
  private readonly _pandoraAddress: string
  private readonly _withCDN: boolean
  private readonly _proofSetId: number
  private readonly _signer: ethers.Signer

  // AddRoots batching state
  private _pendingRoots: Array<{
    rootData: RootData
    resolve: (rootId: number) => void
    reject: (error: Error) => void
    callbacks?: UploadCallbacks
  }> = []

  private _isProcessing: boolean = false

  // Public properties from interface
  public readonly proofSetId: string
  public readonly storageProvider: string

  /**
   * Validate data size against minimum and maximum limits
   * @param sizeBytes - Size of data in bytes
   * @param context - Context for error messages (e.g., 'upload', 'preflightUpload')
   * @throws Error if size is outside allowed limits
   */
  private static validateRawSize (sizeBytes: number, context: string): void {
    if (sizeBytes < SIZE_CONSTANTS.MIN_UPLOAD_SIZE) {
      // This restriction is imposed by CommP calculation, which requires at least 65 bytes
      throw createError(
        'StorageService',
        context,
        `Data size (${sizeBytes} bytes) is below minimum allowed size (${SIZE_CONSTANTS.MIN_UPLOAD_SIZE} bytes).`
      )
    }

    if (sizeBytes > SIZE_CONSTANTS.MAX_UPLOAD_SIZE) {
      // This restriction is ~arbitrary for now, but there is a hard limit on PDP uploads in Curio
      // of 254 MiB, see: https://github.com/filecoin-project/curio/blob/3ddc785218f4e237f0c073bac9af0b77d0f7125c/pdp/handlers_upload.go#L38
      // We can increase this in future, arbitrarily, but we first need to:
      //  - Handle streaming input.
      //  - Chunking input at size 254 MiB and make a separate piece per each chunk
      //  - Combine the pieces using "subpieces" and an aggregate CommP in our AddRoots call
      throw createError(
        'StorageService',
        context,
        `Data size (${sizeBytes} bytes) exceeds maximum allowed size (${SIZE_CONSTANTS.MAX_UPLOAD_SIZE} bytes)`
      )
    }
  }

  constructor (
    synapse: Synapse,
    pandoraService: PandoraService,
    provider: ApprovedProviderInfo,
    proofSetId: number,
    options: StorageServiceOptions
  ) {
    this._synapse = synapse
    this._provider = provider
    this._proofSetId = proofSetId
    this._withCDN = options.withCDN ?? false
    this._signer = synapse.getSigner()
    this._pandoraService = pandoraService

    // Set public properties
    this.proofSetId = proofSetId.toString()
    this.storageProvider = provider.owner

    // Get Pandora address from Synapse (which already handles override)
    this._pandoraAddress = synapse.getPandoraAddress()

    // Create PDPAuthHelper for signing operations
    const authHelper = new PDPAuthHelper(
      this._pandoraAddress,
      this._signer,
      synapse.getChainId()
    )

    // Create PDPServer instance with provider URLs
    this._pdpServer = new PDPServer(
      authHelper,
      provider.pdpUrl,
      provider.pieceRetrievalUrl
    )
  }

  /**
   * Static factory method to create a StorageService
   * Handles provider selection and proof set selection/creation
   */
  static async create (
    synapse: Synapse,
    pandoraService: PandoraService,
    options: StorageServiceOptions
  ): Promise<StorageService> {
    const signer = synapse.getSigner()
    const signerAddress = await signer.getAddress()

    // Use the new resolution logic
    const resolution = await StorageService.resolveProviderAndProofSet(
      synapse,
      pandoraService,
      signerAddress,
      options
    )

    // Notify callback about provider selection
    try {
      options.callbacks?.onProviderSelected?.(resolution.provider)
    } catch (error) {
      // Log but don't propagate callback errors
      console.error('Error in onProviderSelected callback:', error)
    }

    // If we need to create a new proof set
    let finalProofSetId: number
    if (resolution.proofSetId === -1) {
      // Need to create new proof set
      finalProofSetId = await StorageService.createProofSet(
        synapse,
        pandoraService,
        resolution.provider,
        options.withCDN ?? false,
        options.callbacks
      )
    } else {
      // Use existing proof set
      finalProofSetId = resolution.proofSetId

      // Notify callback about proof set resolution (fast path)
      try {
        options.callbacks?.onProofSetResolved?.({
          isExisting: true,
          proofSetId: finalProofSetId,
          provider: resolution.provider
        })
      } catch (error) {
        console.error('Error in onProofSetResolved callback:', error)
      }
    }

    // Create and return service instance
    return new StorageService(synapse, pandoraService, resolution.provider, finalProofSetId, options)
  }

  /**
   * Create a new proof set for the given provider
   */
  private static async createProofSet (
    synapse: Synapse,
    pandoraService: PandoraService,
    provider: ApprovedProviderInfo,
    withCDN: boolean,
    callbacks?: StorageCreationCallbacks
  ): Promise<number> {
    const signer = synapse.getSigner()
    const signerAddress = await signer.getAddress()

    // Create a new proof set

    // Get next client dataset ID
    const nextDatasetId = await pandoraService.getNextClientDataSetId(signerAddress)

    // Get pandora address from synapse
    const pandoraAddress = synapse.getPandoraAddress()

    // Create PDPAuthHelper for signing
    const authHelper = new PDPAuthHelper(
      pandoraAddress,
      signer,
      synapse.getChainId()
    )

    // Create PDPServer instance for API calls
    const pdpServer = new PDPServer(
      authHelper,
      provider.pdpUrl,
      provider.pieceRetrievalUrl
    )

    // Create the proof set through the provider
    const createResult = await pdpServer.createProofSet(
      nextDatasetId, // clientDataSetId
      provider.owner, // payee (storage provider)
      withCDN,
      pandoraAddress // recordKeeper (Pandora contract)
    )

    // createProofSet returns CreateProofSetResponse with txHash and statusUrl
    const { txHash, statusUrl } = createResult

    // Fetch the transaction object from the chain with retry logic
    const ethersProvider = synapse.getProvider()
    let transaction: ethers.TransactionResponse | null = null

    // Retry if the transaction is not found immediately
    const txRetryStartTime = Date.now()
    const txPropagationTimeout = TIMING_CONSTANTS.TRANSACTION_PROPAGATION_TIMEOUT_MS
    const txPropagationPollInterval = TIMING_CONSTANTS.TRANSACTION_PROPAGATION_POLL_INTERVAL_MS

    while (Date.now() - txRetryStartTime < txPropagationTimeout) {
      try {
        transaction = await ethersProvider.getTransaction(txHash)
        if (transaction !== null) {
          break // Transaction found, exit retry loop
        }
      } catch (error) {
        // Log error but continue retrying
        console.warn(`Failed to fetch transaction ${txHash}, retrying...`, error)
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, txPropagationPollInterval))
    }

    // If transaction still not found after retries, throw error
    if (transaction === null) {
      throw createError(
        'StorageService',
        'create',
        `Transaction ${txHash} not found after ${txPropagationTimeout / 1000} seconds. The transaction may not have propagated to the RPC node.`
      )
    }

    // Notify callback about proof set creation started
    try {
      callbacks?.onProofSetCreationStarted?.(transaction, statusUrl)
    } catch (error) {
      console.error('Error in onProofSetCreationStarted callback:', error)
    }

    // Wait for the proof set creation to be confirmed on-chain with progress callbacks
    let finalStatus: Awaited<ReturnType<typeof pandoraService.getComprehensiveProofSetStatus>>

    try {
      finalStatus = await pandoraService.waitForProofSetCreationWithStatus(
        transaction,
        pdpServer,
        TIMING_CONSTANTS.PROOF_SET_CREATION_TIMEOUT_MS,
        TIMING_CONSTANTS.PROOF_SET_CREATION_POLL_INTERVAL_MS,
        async (status, elapsedMs) => {
          // Fire progress callback
          if (callbacks?.onProofSetCreationProgress != null) {
            try {
              // Get receipt if transaction is mined
              let receipt: ethers.TransactionReceipt | undefined
              if (status.chainStatus.transactionMined && status.chainStatus.blockNumber != null) {
                try {
                  // Use transaction.wait() which is more efficient than getTransactionReceipt
                  const txReceipt = await transaction.wait(TIMING_CONSTANTS.TRANSACTION_CONFIRMATIONS)
                  receipt = txReceipt ?? undefined
                } catch (error) {
                  console.error('Failed to fetch transaction receipt:', error)
                }
              }

              callbacks.onProofSetCreationProgress({
                transactionMined: status.chainStatus.transactionMined,
                transactionSuccess: status.chainStatus.transactionSuccess,
                proofSetLive: status.chainStatus.proofSetLive,
                serverConfirmed: status.serverStatus?.ok === true,
                proofSetId: status.summary.proofSetId ?? undefined,
                elapsedMs,
                receipt
              })
            } catch (error) {
              console.error('Error in onProofSetCreationProgress callback:', error)
            }
          }
        }
      )
    } catch (error) {
      throw createError(
        'StorageService',
        'waitForProofSetCreation',
        error instanceof Error ? error.message : 'Proof set creation failed'
      )
    }

    if (!finalStatus.summary.isComplete || finalStatus.summary.proofSetId == null) {
      throw createError(
        'StorageService',
        'waitForProofSetCreation',
        `Proof set creation failed: ${finalStatus.summary.error ?? 'Transaction may have failed'}`
      )
    }

    const proofSetId = finalStatus.summary.proofSetId

    // Notify callback about proof set resolution (slow path)
    try {
      callbacks?.onProofSetResolved?.({
        isExisting: false,
        proofSetId,
        provider
      })
    } catch (error) {
      console.error('Error in onProofSetResolved callback:', error)
    }

    return proofSetId
  }

  /**
   * Resolve provider and proof set based on provided options
   * Uses lazy loading to minimize RPC calls
   */
  private static async resolveProviderAndProofSet (
    synapse: Synapse,
    pandoraService: PandoraService,
    signerAddress: string,
    options: StorageServiceOptions
  ): Promise<{
      provider: ApprovedProviderInfo
      proofSetId: number
      isExisting: boolean
    }> {
    // Handle explicit proof set ID selection (highest priority)
    if (options.proofSetId != null) {
      return await StorageService.resolveByProofSetId(
        options.proofSetId,
        pandoraService,
        signerAddress,
        options
      )
    }

    // Handle explicit provider ID selection
    if (options.providerId != null) {
      return await StorageService.resolveByProviderId(
        options.providerId,
        pandoraService,
        signerAddress,
        options.withCDN ?? false
      )
    }

    // Handle explicit provider address selection
    if (options.providerAddress != null) {
      return await StorageService.resolveByProviderAddress(
        options.providerAddress,
        pandoraService,
        signerAddress,
        options.withCDN ?? false
      )
    }

    // Smart selection when no specific parameters provided
    return await StorageService.smartSelectProvider(
      pandoraService,
      signerAddress,
      options.withCDN ?? false,
      synapse.getSigner()
    )
  }

  /**
   * Resolve by explicit proof set ID
   */
  private static async resolveByProofSetId (
    proofSetId: number,
    pandoraService: PandoraService,
    signerAddress: string,
    options: StorageServiceOptions
  ): Promise<{
      provider: ApprovedProviderInfo
      proofSetId: number
      isExisting: boolean
    }> {
    // Fetch proof sets to find the specific one
    const proofSets = await pandoraService.getClientProofSetsWithDetails(signerAddress)
    const proofSet = proofSets.find(ps => ps.pdpVerifierProofSetId === proofSetId)

    if (proofSet == null || !proofSet.isLive || !proofSet.isManaged) {
      throw createError(
        'StorageService',
        'resolveByProofSetId',
        `Proof set ${proofSetId} not found, not owned by ${signerAddress}, ` +
        'or not managed by the current Pandora contract'
      )
    }

    // Validate consistency with other parameters if provided
    if (options.providerId != null || options.providerAddress != null) {
      await StorageService.validateProofSetConsistency(proofSet, options, pandoraService)
    }

    // Look up provider by address
    const providerId = await pandoraService.getProviderIdByAddress(proofSet.payee)
    if (providerId === 0) {
      throw createError(
        'StorageService',
        'resolveByProofSetId',
        `Provider ${proofSet.payee} for proof set ${proofSetId} is not currently approved`
      )
    }

    const provider = await pandoraService.getApprovedProvider(providerId)

    return {
      provider,
      proofSetId,
      isExisting: true
    }
  }

  /**
   * Validate that proof set parameters are consistent. This allows us to be more flexible in
   * options we allow up-front as long as they don't conflict when we resolve the proof set using
   * them in priority order.
   */
  private static async validateProofSetConsistency (
    proofSet: EnhancedProofSetInfo,
    options: StorageServiceOptions,
    pandoraService: PandoraService
  ): Promise<void> {
    // If providerId is specified, validate it matches
    if (options.providerId != null) {
      const providerId = await pandoraService.getProviderIdByAddress(proofSet.payee)
      if (providerId !== options.providerId) {
        throw createError(
          'StorageService',
          'validateProofSetConsistency',
          `Proof set ${proofSet.pdpVerifierProofSetId} belongs to provider ID ${providerId}, ` +
          `but provider ID ${options.providerId} was requested`
        )
      }
    }

    // If providerAddress is specified, validate it matches
    if (options.providerAddress != null) {
      if (proofSet.payee.toLowerCase() !== options.providerAddress.toLowerCase()) {
        throw createError(
          'StorageService',
          'validateProofSetConsistency',
          `Proof set ${proofSet.pdpVerifierProofSetId} belongs to provider ${proofSet.payee}, ` +
          `but provider ${options.providerAddress} was requested`
        )
      }
    }
  }

  /**
   * Resolve by explicit provider ID
   */
  private static async resolveByProviderId (
    providerId: number,
    pandoraService: PandoraService,
    signerAddress: string,
    withCDN: boolean
  ): Promise<{
      provider: ApprovedProviderInfo
      proofSetId: number
      isExisting: boolean
    }> {
    // Fetch provider info and proof sets in parallel
    const [provider, proofSets] = await Promise.all([
      pandoraService.getApprovedProvider(providerId),
      pandoraService.getClientProofSetsWithDetails(signerAddress)
    ])

    if (provider.owner === '0x0000000000000000000000000000000000000000') {
      throw createError(
        'StorageService',
        'resolveByProviderId',
        `Provider ID ${providerId} not found or not approved`
      )
    }

    // Filter for this provider's proof sets
    const providerProofSets = proofSets.filter(
      ps => ps.payee.toLowerCase() === provider.owner.toLowerCase() &&
            ps.isLive &&
            ps.isManaged &&
            ps.withCDN === withCDN
    )

    if (providerProofSets.length > 0) {
      // Sort by preference: proof sets with roots first, then by ID
      const sorted = providerProofSets.sort((a, b) => {
        if (a.currentRootCount > 0 && b.currentRootCount === 0) return -1
        if (b.currentRootCount > 0 && a.currentRootCount === 0) return 1
        return a.pdpVerifierProofSetId - b.pdpVerifierProofSetId
      })

      return {
        provider,
        proofSetId: sorted[0].pdpVerifierProofSetId,
        isExisting: true
      }
    }

    // No existing proof sets, will create new
    return {
      provider,
      proofSetId: -1, // Marker for new proof set
      isExisting: false
    }
  }

  /**
   * Resolve by explicit provider address
   */
  private static async resolveByProviderAddress (
    providerAddress: string,
    pandoraService: PandoraService,
    signerAddress: string,
    withCDN: boolean
  ): Promise<{
      provider: ApprovedProviderInfo
      proofSetId: number
      isExisting: boolean
    }> {
    // Get provider ID by address
    const providerId = await pandoraService.getProviderIdByAddress(providerAddress)
    if (providerId === 0) {
      throw createError(
        'StorageService',
        'resolveByProviderAddress',
        `Provider ${providerAddress} is not currently approved`
      )
    }

    // Use the providerId resolution logic
    return await StorageService.resolveByProviderId(
      providerId,
      pandoraService,
      signerAddress,
      withCDN
    )
  }

  /**
   * Smart selection when no explicit parameters provided
   * Uses progressive data fetching to minimize RPC calls
   */
  private static async smartSelectProvider (
    pandoraService: PandoraService,
    signerAddress: string,
    withCDN: boolean,
    signer: ethers.Signer
  ): Promise<{
      provider: ApprovedProviderInfo
      proofSetId: number
      isExisting: boolean
    }> {
    // Step 1: First try to get client's proof sets
    const proofSets = await pandoraService.getClientProofSetsWithDetails(signerAddress)

    // Filter for managed proof sets with matching CDN setting
    const managedProofSets = proofSets.filter(
      ps => ps.isLive && ps.isManaged && ps.withCDN === withCDN
    )

    if (managedProofSets.length > 0) {
      // Prefer proof sets with roots, sort by ID (older first)
      const sorted = managedProofSets.sort((a, b) => {
        if (a.currentRootCount > 0 && b.currentRootCount === 0) return -1
        if (b.currentRootCount > 0 && a.currentRootCount === 0) return 1
        return a.pdpVerifierProofSetId - b.pdpVerifierProofSetId
      })
      const selected = sorted[0]

      // Get the provider for this proof set
      const providerId = await pandoraService.getProviderIdByAddress(selected.payee)
      if (providerId === 0) {
        throw createError(
          'StorageService',
          'smartSelectProvider',
          `Provider ${selected.payee} for proof set ${selected.pdpVerifierProofSetId} is not currently approved`
        )
      }

      const provider = await pandoraService.getApprovedProvider(providerId)

      return {
        provider,
        proofSetId: selected.pdpVerifierProofSetId,
        isExisting: true
      }
    }

    // Step 2: No existing proof sets, need to select a provider for new proof set
    const allProviders = await pandoraService.getAllApprovedProviders()

    if (allProviders.length === 0) {
      throw createError(
        'StorageService',
        'smartSelectProvider',
        'No approved storage providers available'
      )
    }

    // Random selection from all providers
    const provider = await StorageService.selectRandomProvider(allProviders, signer)

    return {
      provider,
      proofSetId: -1, // Marker for new proof set
      isExisting: false
    }
  }

  /**
   * Select a random provider from the given list
   */
  private static async selectRandomProvider (
    providers: ApprovedProviderInfo[],
    signer: ethers.Signer
  ): Promise<ApprovedProviderInfo> {
    let randomIndex: number

    // Try crypto.getRandomValues if available (HTTPS contexts)
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues != null) {
      const randomBytes = new Uint8Array(1)
      globalThis.crypto.getRandomValues(randomBytes)
      randomIndex = randomBytes[0] % providers.length
    } else {
      // Fallback for HTTP contexts - use multiple entropy sources
      const timestamp = Date.now()
      const random = Math.random()
      // Use wallet address as additional entropy
      const addressBytes = await signer.getAddress()
      const addressSum = addressBytes.split('').reduce((a, c) => a + c.charCodeAt(0), 0)

      // Combine sources for better distribution
      const combined = (timestamp * random * addressSum) % providers.length
      randomIndex = Math.floor(Math.abs(combined))
    }

    return providers[randomIndex]
  }

  /**
   * Run preflight checks for an upload
   */
  async preflightUpload (size: number): Promise<PreflightInfo> {
    // Validate size before proceeding
    StorageService.validateRawSize(size, 'preflightUpload')

    // Check allowances and get costs in a single call
    const allowanceCheck = await this._pandoraService.checkAllowanceForStorage(
      size,
      this._withCDN,
      this._synapse.payments
    )

    // Return preflight info
    return {
      estimatedCost: {
        perEpoch: allowanceCheck.costs.perEpoch,
        perDay: allowanceCheck.costs.perDay,
        perMonth: allowanceCheck.costs.perMonth
      },
      allowanceCheck: {
        sufficient: allowanceCheck.sufficient,
        message: allowanceCheck.message
      },
      selectedProvider: this._provider,
      selectedProofSetId: this._proofSetId
    }
  }

  /**
   * Upload data to the storage provider
   */
  async upload (data: Uint8Array | ArrayBuffer, callbacks?: UploadCallbacks): Promise<UploadResult> {
    // Validation Phase: Check data size
    const dataBytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const sizeBytes = dataBytes.length

    // Validate size before proceeding
    StorageService.validateRawSize(sizeBytes, 'upload')

    // Upload Phase: Upload data to storage provider
    let uploadResult: { commP: CommP, size: number }
    try {
      uploadResult = await this._pdpServer.uploadPiece(dataBytes)
    } catch (error) {
      throw createError(
        'StorageService',
        'uploadPiece',
        'Failed to upload piece to storage provider',
        error
      )
    }

    // Poll for piece to be "parked" (ready)
    const maxWaitTime = TIMING_CONSTANTS.PIECE_PARKING_TIMEOUT_MS
    const pollInterval = TIMING_CONSTANTS.PIECE_PARKING_POLL_INTERVAL_MS
    const startTime = Date.now()
    let pieceReady = false

    while (Date.now() - startTime < maxWaitTime) {
      try {
        await this._pdpServer.findPiece(uploadResult.commP, uploadResult.size)
        pieceReady = true
        break
      } catch {
        // Piece not ready yet, wait and retry if we haven't exceeded timeout
        if (Date.now() - startTime + pollInterval < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, pollInterval))
        }
      }
    }

    if (!pieceReady) {
      throw createError(
        'StorageService',
        'findPiece',
        'Timeout waiting for piece to be parked on storage provider'
      )
    }

    // Notify upload complete
    if (callbacks?.onUploadComplete != null) {
      callbacks.onUploadComplete(uploadResult.commP)
    }

    // Add Root Phase: Queue the AddRoots operation for sequential processing
    const rootData: RootData = {
      cid: uploadResult.commP,
      rawSize: uploadResult.size
    }

    const finalRootId = await new Promise<number>((resolve, reject) => {
      // Add to pending batch
      this._pendingRoots.push({
        rootData,
        resolve,
        reject,
        callbacks
      })

      void this._processPendingRoots()
    })

    // Return upload result
    return {
      commp: uploadResult.commP,
      size: uploadResult.size,
      rootId: finalRootId
    }
  }

  /**
     * Process pending roots by batching them into a single AddRoots operation
     * This method is called from the promise queue to ensure sequential execution
     */
  private async _processPendingRoots (): Promise<void> {
    if (this._isProcessing || this._pendingRoots.length === 0) {
      return
    }
    this._isProcessing = true

    // Extract all pending roots
    const batch = [...this._pendingRoots]
    this._pendingRoots = []

    try {
      // Get add roots info to ensure we have the correct nextRootId
      const addRootsInfo = await this._pandoraService.getAddRootsInfo(
        this._proofSetId
      )

      // Create root data array from the batch
      const rootDataArray: RootData[] = batch.map((item) => item.rootData)

      // Add roots to the proof set
      const addRootsResult = await this._pdpServer.addRoots(
        this._proofSetId, // PDPVerifier proof set ID
        addRootsInfo.clientDataSetId, // Client's dataset ID
        addRootsInfo.nextRootId, // Must match chain state
        rootDataArray
      )

      // Handle transaction tracking if available (backward compatible)
      let confirmedRootIds: number[] = []

      if (addRootsResult.txHash != null) {
        // New server with transaction tracking - verification is REQUIRED
        let transaction: ethers.TransactionResponse | null = null

        // Step 1: Get the transaction from chain
        const txRetryStartTime = Date.now()
        const txPropagationTimeout = TIMING_CONSTANTS.TRANSACTION_PROPAGATION_TIMEOUT_MS
        const txPropagationPollInterval = TIMING_CONSTANTS.TRANSACTION_PROPAGATION_POLL_INTERVAL_MS

        while (Date.now() - txRetryStartTime < txPropagationTimeout) {
          try {
            transaction = await this._synapse.getProvider().getTransaction(addRootsResult.txHash)
            if (transaction !== null) break
          } catch {
            // Transaction not found yet
          }
          await new Promise(resolve => setTimeout(resolve, txPropagationPollInterval))
        }

        if (transaction == null) {
          throw createError(
            'StorageService',
            'addRoots',
            `Server returned transaction hash ${addRootsResult.txHash} but transaction was not found on-chain after ${txPropagationTimeout / 1000} seconds`
          )
        }

        // Notify callbacks with transaction
        batch.forEach((item) => item.callbacks?.onRootAdded?.(transaction))

        // Step 2: Wait for transaction confirmation
        let receipt: ethers.TransactionReceipt | null
        try {
          receipt = await transaction.wait(TIMING_CONSTANTS.TRANSACTION_CONFIRMATIONS)
        } catch (error) {
          throw createError(
            'StorageService',
            'addRoots',
            'Failed to wait for transaction confirmation',
            error
          )
        }

        if (receipt?.status !== 1) {
          throw createError(
            'StorageService',
            'addRoots',
            'Root addition transaction failed on-chain'
          )
        }

        // Step 3: Verify with server - REQUIRED for new servers
        const maxWaitTime = TIMING_CONSTANTS.ROOT_ADDITION_TIMEOUT_MS
        const pollInterval = TIMING_CONSTANTS.ROOT_ADDITION_POLL_INTERVAL_MS
        const startTime = Date.now()
        let lastError: Error | null = null
        let statusVerified = false

        while (Date.now() - startTime < maxWaitTime) {
          try {
            const status = await this._pdpServer.getRootAdditionStatus(
              this._proofSetId,
              addRootsResult.txHash
            )

            // Check if the transaction is still pending
            if (status.txStatus === 'pending') {
              await new Promise(resolve => setTimeout(resolve, pollInterval))
              continue
            }

            // Check if transaction failed
            if (status.addMessageOk === false) {
              throw new Error('Root addition failed: Transaction was unsuccessful')
            }

            // Success - get the root IDs
            if (status.confirmedRootIds != null && status.confirmedRootIds.length > 0) {
              confirmedRootIds = status.confirmedRootIds
              batch.forEach((item) =>
                item.callbacks?.onRootConfirmed?.(status.confirmedRootIds ?? [])
              )
              statusVerified = true
              break
            }

            // If we get here, status exists but no root IDs yet
            await new Promise(resolve => setTimeout(resolve, pollInterval))
          } catch (error) {
            lastError = error as Error
            // If it's a 404, the server might not have the record yet
            if (error instanceof Error && error.message.includes('not found')) {
              await new Promise(resolve => setTimeout(resolve, pollInterval))
              continue
            }
            // Other errors are fatal
            throw createError(
              'StorageService',
              'addRoots',
                `Failed to verify root addition with server: ${error instanceof Error ? error.message : 'Unknown error'}`,
                error
            )
          }
        }

        if (!statusVerified) {
          const errorMessage = `Failed to verify root addition after ${maxWaitTime / 1000} seconds: ${
            lastError != null ? lastError.message : 'Server did not provide confirmation'
          }`

          throw createError(
            'StorageService',
            'addRoots',
            errorMessage + '. The transaction was confirmed on-chain but the server failed to acknowledge it.',
            lastError
          )
        }
      } else {
        // Old server without transaction tracking
        // Generate sequential root IDs starting from nextRootId
        confirmedRootIds = Array.from(
          { length: batch.length },
          (_, i) => addRootsInfo.nextRootId + i
        )
        batch.forEach((item) => item.callbacks?.onRootAdded?.())
      }

      // Resolve all promises in the batch with their respective root IDs
      batch.forEach((item, index) => {
        const rootId =
            confirmedRootIds[index] ?? addRootsInfo.nextRootId + index
        item.resolve(rootId)
      })
    } catch (error) {
      // Reject all promises in the batch
      const finalError = createError(
        'StorageService',
        'addRoots',
        'Failed to add root to proof set',
        error
      )
      batch.forEach((item) => item.reject(finalError))
    } finally {
      this._isProcessing = false
      if (this._pendingRoots.length > 0) {
        void this._processPendingRoots().catch()
      }
    }
  }

  /**
   * Download data from this specific storage provider
   * @param commp - The CommP identifier
   * @param options - Download options (currently unused but reserved for future)
   * @returns The downloaded data
   */
  async providerDownload (commp: string | CommP, options?: DownloadOptions): Promise<Uint8Array> {
    // Pass through to Synapse with our provider hint and withCDN setting
    return await this._synapse.download(commp, {
      providerAddress: this._provider.owner,
      withCDN: this._withCDN // Pass StorageService's withCDN
    })
  }

  /**
   * Download data from the storage provider
   * @deprecated Use providerDownload() for downloads from this specific provider.
   * This method will be removed in a future version.
   */
  async download (commp: string | CommP, options?: DownloadOptions): Promise<Uint8Array> {
    return await this.providerDownload(commp, options)
  }
}
