import { PrismaClient, ServiceStatus, PermissionState, AccessResult } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // ─── Clear existing data ────────────────────────────────────────────────────

  console.log("🗑️  Clearing existing data...");
  await prisma.accessLog.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.service.deleteMany();
  await prisma.user.deleteMany();

  // ─── Create User ────────────────────────────────────────────────────────────

  console.log("👤 Creating user...");
  const user = await prisma.user.create({
    data: {
      email: "user@hussh.io",
      trustScore: 87,
    },
  });

  // ─── Create Services ────────────────────────────────────────────────────────

  console.log("🔗 Creating services...");
  const services = await prisma.service.createMany({
    data: [
      {
        publicId: "svc_001",
        userId: user.id,
        name: "Google Workspace",
        icon: "google",
        status: ServiceStatus.Active,
        connectedAt: new Date("2025-11-02T09:15:00Z"),
        scopes: ["email.read", "calendar.readonly", "drive.readonly"],
        lastSync: new Date("2026-03-25T04:30:00Z"),
      },
      {
        publicId: "svc_002",
        userId: user.id,
        name: "Slack",
        icon: "slack",
        status: ServiceStatus.Active,
        connectedAt: new Date("2025-12-18T14:22:00Z"),
        scopes: ["channels:read", "users:read", "chat:write"],
        lastSync: new Date("2026-03-25T05:00:00Z"),
      },
      {
        publicId: "svc_003",
        userId: user.id,
        name: "GitHub",
        icon: "github",
        status: ServiceStatus.Pending,
        connectedAt: new Date("2026-03-20T11:45:00Z"),
        scopes: ["repo", "read:org"],
        lastSync: null,
      },
      {
        publicId: "svc_004",
        userId: user.id,
        name: "Notion",
        icon: "notion",
        status: ServiceStatus.Revoked,
        connectedAt: new Date("2025-08-10T08:00:00Z"),
        scopes: ["read_content", "update_content"],
        lastSync: new Date("2026-01-15T23:59:00Z"),
      },
      {
        publicId: "svc_005",
        userId: user.id,
        name: "Figma",
        icon: "figma",
        status: ServiceStatus.Active,
        connectedAt: new Date("2026-01-05T16:30:00Z"),
        scopes: ["file:read", "file:write"],
        lastSync: new Date("2026-03-24T18:12:00Z"),
      },
      {
        publicId: "svc_006",
        userId: user.id,
        name: "Dropbox",
        icon: "dropbox",
        status: ServiceStatus.Pending,
        connectedAt: new Date("2026-03-22T10:00:00Z"),
        scopes: ["files.metadata.read", "files.content.read"],
        lastSync: null,
      },
    ],
  });

  // ─── Create Permissions ──────────────────────────────────────────────────────

  console.log("🔐 Creating permissions...");
  const permissions = await prisma.permission.createMany({
    data: [
      {
        publicId: "perm_001",
        userId: user.id,
        category: "Data Sharing",
        label: "Share usage analytics",
        description:
          "Allow aggregated usage data to be shared with connected services for improved recommendations.",
        state: PermissionState.On,
        lastModified: new Date("2026-02-14T10:00:00Z"),
      },
      {
        publicId: "perm_002",
        userId: user.id,
        category: "Data Sharing",
        label: "Third-party data enrichment",
        description:
          "Permit third-party providers to enrich your profile data for personalization.",
        state: PermissionState.Off,
        lastModified: new Date("2026-01-20T08:30:00Z"),
      },
      {
        publicId: "perm_003",
        userId: user.id,
        category: "Notifications",
        label: "Email notifications",
        description:
          "Receive email alerts for account activity, permission changes, and security events.",
        state: PermissionState.On,
        lastModified: new Date("2025-12-01T12:00:00Z"),
      },
      {
        publicId: "perm_004",
        userId: user.id,
        category: "Notifications",
        label: "Push notifications",
        description:
          "Receive real-time push alerts on your devices for critical security events.",
        state: PermissionState.On,
        lastModified: new Date("2026-03-01T09:15:00Z"),
      },
      {
        publicId: "perm_005",
        userId: user.id,
        category: "Security",
        label: "Biometric authentication",
        description:
          "Use fingerprint or face recognition as a second factor for sensitive actions.",
        state: PermissionState.Off,
        lastModified: new Date("2026-02-28T17:45:00Z"),
      },
      {
        publicId: "perm_006",
        userId: user.id,
        category: "Security",
        label: "Login from new devices",
        description:
          "Require additional verification when signing in from an unrecognised device.",
        state: PermissionState.On,
        lastModified: new Date("2026-03-10T14:00:00Z"),
      },
      {
        publicId: "perm_007",
        userId: user.id,
        category: "Privacy",
        label: "Location tracking",
        description:
          "Allow services to access your approximate location for region-specific features.",
        state: PermissionState.Off,
        lastModified: new Date("2026-03-18T11:30:00Z"),
      },
      {
        publicId: "perm_008",
        userId: user.id,
        category: "Privacy",
        label: "Cookie consent — marketing",
        description:
          "Allow marketing-related cookies for personalised ads across connected services.",
        state: PermissionState.Off,
        lastModified: new Date("2026-01-05T16:00:00Z"),
      },
    ],
  });

  // ─── Create Access Logs ──────────────────────────────────────────────────────

  console.log("📋 Creating access logs...");
  const accessLogs = await prisma.accessLog.createMany({
    data: [
      {
        publicId: "log_001",
        userId: user.id,
        timestamp: new Date("2026-03-25T05:12:33Z"),
        service: "Google Workspace",
        action: "READ",
        resource: "/api/emails/inbox",
        result: AccessResult.Authorized,
        ip: "192.168.1.42",
      },
      {
        publicId: "log_002",
        userId: user.id,
        timestamp: new Date("2026-03-25T04:58:10Z"),
        service: "Slack",
        action: "WRITE",
        resource: "/api/messages/send",
        result: AccessResult.Authorized,
        ip: "192.168.1.42",
      },
      {
        publicId: "log_003",
        userId: user.id,
        timestamp: new Date("2026-03-25T03:47:22Z"),
        service: "GitHub",
        action: "READ",
        resource: "/api/repos/private",
        result: AccessResult.BLOCKED_BY_CONSENT,
        ip: "10.0.0.15",
      },
      {
        publicId: "log_004",
        userId: user.id,
        timestamp: new Date("2026-03-25T02:30:05Z"),
        service: "Notion",
        action: "READ",
        resource: "/api/pages/workspace",
        result: AccessResult.BLOCKED_BY_CONSENT,
        ip: "203.0.113.7",
      },
      {
        publicId: "log_005",
        userId: user.id,
        timestamp: new Date("2026-03-24T23:15:44Z"),
        service: "Figma",
        action: "READ",
        resource: "/api/files/recent",
        result: AccessResult.Authorized,
        ip: "192.168.1.42",
      },
      {
        publicId: "log_006",
        userId: user.id,
        timestamp: new Date("2026-03-24T21:08:19Z"),
        service: "Google Workspace",
        action: "READ",
        resource: "/api/calendar/events",
        result: AccessResult.Authorized,
        ip: "192.168.1.42",
      },
      {
        publicId: "log_007",
        userId: user.id,
        timestamp: new Date("2026-03-24T19:55:00Z"),
        service: "Dropbox",
        action: "READ",
        resource: "/api/files/metadata",
        result: AccessResult.BLOCKED_BY_CONSENT,
        ip: "10.0.0.15",
      },
      {
        publicId: "log_008",
        userId: user.id,
        timestamp: new Date("2026-03-24T18:42:31Z"),
        service: "Slack",
        action: "READ",
        resource: "/api/channels/list",
        result: AccessResult.Authorized,
        ip: "192.168.1.42",
      },
      {
        publicId: "log_009",
        userId: user.id,
        timestamp: new Date("2026-03-24T17:30:12Z"),
        service: "Unknown Client",
        action: "WRITE",
        resource: "/api/user/profile",
        result: AccessResult.Denied,
        ip: "45.33.32.156",
      },
      {
        publicId: "log_010",
        userId: user.id,
        timestamp: new Date("2026-03-24T15:10:48Z"),
        service: "Google Workspace",
        action: "READ",
        resource: "/api/drive/files",
        result: AccessResult.Rate_Limited,
        ip: "192.168.1.42",
      },
    ],
  });

  console.log(
    `✅ Seed complete! Created 1 user, ${services.count} services, ${permissions.count} permissions, and ${accessLogs.count} access logs.`
  );
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
