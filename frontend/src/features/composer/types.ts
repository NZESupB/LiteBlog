export interface VideoVersion {
  size: number
  codec?: string
  width?: number
  height?: number
  rate?: number
  bitDepth?: number
  hdr?: boolean
  available?: boolean
}
export interface VideoResult {
  message?: string
  totalElapsedMs?: number
  variants?: Partial<Record<'original' | 'compressed', VideoVersion>>
  recommendedVariant?: string
  selectedVariant?: string
  canSelect?: boolean
  comparison?: { compressed: boolean; savingPercent: number; compressionRatio: number; changes: string[] }
}
export interface DraftMedia {
  id?: number
  name?: string
  type?: string
  url?: string
  poster?: string
  live?: boolean
  duration?: number
  _id?: string
  _kind?: string
  _url?: string
  _status?: string
  _errMsg?: string
  _motion?: DraftMedia | null
  _duration?: number
  _jobId?: string
  _warnings?: { message: string; blocking?: boolean }[]
  _needsReview?: boolean
  _discarding?: boolean
  _parsing?: boolean
  _needsFile?: boolean
  _canRetry?: boolean
  _file?: File
  _videoResult?: VideoResult
}
export interface ComposerState {
  content: string
  publicText: boolean
  publicImages: boolean
  files: DraftMedia[]
  keep: DraftMedia[]
  restoring: boolean
  restoreError: string
  error: string
  saved: boolean
  busy: boolean
  imageBusy: boolean
  imageTask: { id: string; status: string; error?: string; previewUrl?: string } | null
  polish: { open: boolean; running: boolean; origin: string; result: string; status: string }
}
export interface ComposerService {
  getState(): ComposerState
  subscribe(listener: () => void): () => void
  start(): Promise<void>
  dispose(): void
  set(field: 'content', value: string): void
  set(field: 'publicText' | 'publicImages', value: boolean): void
  addFiles(files: File[]): Promise<void>
  remove(item: DraftMedia): Promise<void>
  keepStill(item: DraftMedia): Promise<void>
  retryImage(item: DraftMedia): Promise<void>
  retryVideo(item: DraftMedia, source: File | null, needsPoster: boolean): Promise<void>
  selectVariant(item: DraftMedia, variant: 'original' | 'compressed', needsPoster: boolean): Promise<void>
  imageAction(kind: 'start' | 'retry' | 'cancel' | 'use'): Promise<void>
  polish(): Promise<void>
  closePolish(): void
  adoptPolish(): void
  publishGuard(): string
  publish(): Promise<void>
  discard(): Promise<boolean>
}
