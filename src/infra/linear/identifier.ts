export function parseIssueIdentifier(
  identifier: string,
): { prefix: string; number: number } | null {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}
