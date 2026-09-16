const ROOM_ID = /^[a-zA-Z0-9_-]{16,80}$/;

/** The root is a public introduction; existing shared links remain editor entries. */
export function isEditorLocation(url: URL): boolean {
  return ['/studio', '/studio/', '/studio/index.html'].includes(url.pathname) || ['room', 'projects', 'auth_error'].some(key => url.searchParams.has(key));
}

export function lastRoom(): string | null {
  try {
    const room = localStorage.getItem('poietra-last-room');
    return room && ROOM_ID.test(room) ? room : null;
  } catch { return null; }
}

export function roomLink(room: string): string { return `/?${new URLSearchParams({ room })}`; }
