/** D3 releases are rebuilt and tested locally before installation. */
export const d3Build = {
  automaticUpdates: true,
  remoteServerUpdates: false,
  nativePasskeys: false,
  supportsManagedService: false,
  upstreamTag: "v0.0.41-nightly.20260910.1486",
  repository: "Deniskurs/d3code",
  updateTrack: { channel: "latest", label: "Devis" } as const,
};
