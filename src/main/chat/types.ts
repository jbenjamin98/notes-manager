/** One Chat message as every source hands it over (OAuth full history, or the bridge's partial feed). */
export interface ChatIn {
  id: string
  /** Space id/name as the source knows it. */
  space: string
  spaceName: string
  spaceType: 'dm' | 'group' | 'space'
  sender: string
  senderId: string | null
  /** Message text (up to 4000 characters). */
  text: string
  createdAt: string
  thread: string | null
  mentionsMe: boolean
  fromMe: boolean
}

export type SpaceMode = 'track' | 'mentions' | 'ignore'
