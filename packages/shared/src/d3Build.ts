/** D3 releases retain fork changes and pass release checks before publication. */
export const d3Build = {
  automaticUpdates: true,
  remoteServerUpdates: false,
  nativePasskeys: false,
  supportsManagedService: false,
  upstreamTag: "v0.0.41-nightly.20260915.1752",
  repository: "Deniskurs/d3code",
  updateTrack: { channel: "latest", label: "Devis" } as const,
};
