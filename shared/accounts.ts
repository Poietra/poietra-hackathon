export type AuthProvider = 'google' | 'github';
export interface AccountUser { id: string; name: string; provider: AuthProvider }
export interface AuthSession { user: AccountUser | null; providers: Record<AuthProvider, boolean> }
/** Private bookmarks, separate from the shared project document. Removing one never deletes a room. */
export interface AccountProject { roomId: string; name: string; updatedAt: number }
