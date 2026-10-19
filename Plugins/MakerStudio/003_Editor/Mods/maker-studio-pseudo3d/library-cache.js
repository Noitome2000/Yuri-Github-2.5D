// Keep checking the file on map switches so external imports remain visible.
// Equality is against the complete source, not a revision that external tools
// may forget to increment. Only one accepted library is retained.
export function createLibraryCache(normalize) {
  let source, accepted;
  return {
    read(text, current) {
      if (accepted && current === accepted && text === source) return current;
      const next = normalize(text == null ? null : JSON.parse(text));
      source = text;
      accepted = next;
      return next;
    },
    remember(text, current) { source = text; accepted = current; },
    isCurrent(current) { return current === accepted; },
    clear() { source = undefined; accepted = undefined; }
  };
}
