export interface User {
  id: number
  username: string
  name: string
  displayName: string
  avatarUrl: string | null
}
export interface Site {
  title: string
  anniversary: string
  privateMode: boolean
  user: User | null
  reactionEmojis: string[]
}
export interface Media {
  id: number
  type: 'image' | 'video'
  url: string
  poster?: string
  duration?: number
  live?: boolean
  motion?: string
  created_at?: string
  author?: string
}
export interface Reaction {
  emoji: string
  count: number
  reacted: boolean
}
export interface Post {
  id: number
  content: string
  created_at: string
  updated_at: string
  user_id: number
  author: string
  avatarUrl: string | null
  public_text: number
  public_images: number
  canEdit: boolean
  images: Media[]
  reactions: Reaction[]
}
export interface Comment {
  id: number
  content: string
  created_at: string
  user_id: number
  reply_to: number | null
  author: string
  avatarUrl: string | null
  reply_author?: string
  reply_content?: string
}
export interface Notice {
  id: number
  post_id: number
  content: string
  created_at: string
  author: string
  post_excerpt: string
  reply_to_me: boolean
}
export const parseTime = (value: string) => new Date(value.replace(' ', 'T') + 'Z')
export const dateLabel = (value: string) =>
  parseTime(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
export const monthKey = (value: string) => {
  const date = parseTime(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
