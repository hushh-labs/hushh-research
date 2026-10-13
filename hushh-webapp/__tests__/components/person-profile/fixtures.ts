// Fresh synthetic profile and recipient-bound grant fixtures.

export function currentGrantFixture(
  requestId: string,
  bundleId: string,
  scopeRef = "scope-0",
) {
  const request = {
    bundleId,
    personRef: "actual-public-ref",
    purpose: "Synthetic review",
    durationSeconds: 86400,
    cancelled: false,
    items: [
      {
        requestId,
        scopeRef,
        label: "Synthetic detail",
        sensitivity: "standard",
        status: "granted",
      },
    ],
  };
  const exported = {
    requestId,
    scopeRef,
    encryptedExport: {
      request_id: requestId,
      scope: "attr.professional.synthetic",
      export_revision: 1,
      export_envelope: {
        version: 2,
        export_id: "synthetic-export",
        aad: {
          version: 2,
          app_id: "agent_one",
          grant_id: requestId,
          export_id: "synthetic-export",
          revision: 1,
          machine_scope: "attr.professional.synthetic",
          payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3_600_000,
        },
      },
    },
  };
  return { request, exported };
}

export function viewerProfile(overrides = {}) {
  return {
    personRef: "actual-public-ref",
    displayName: "Actual Person",
    photoUrl: "https://cdn.example.test/person.jpg",
    verifiedRole: null,
    relationship: {
      status: "connected",
      connectionId: "connection-1",
      connectedAt: null,
      requestId: null,
    },
    requestableScopes: [
      {
        scopeRef: "scope-short",
        label: "Risk profile",
        description: null,
        domain: "Financial",
        sensitivity: "standard",
        wildcard: false,
      },
      {
        scopeRef: "scope-wrapped",
        label: "Profile preferences investment horizon selected at",
        description: null,
        domain: "Financial",
        sensitivity: "standard",
        wildcard: false,
      },
    ],
    grants: [],
    requestHistory: [],
    ...overrides,
  };
}
