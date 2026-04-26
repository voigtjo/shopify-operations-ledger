import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ROLE_CODES,
  DEFAULT_TENANT_SETTINGS,
  bootstrapTenantFromShopifySession,
  type TenantBootstrapStore,
} from "../../app/lib/tenant-bootstrap.server";

vi.mock("../../app/lib/token-encryption.server", () => ({
  encryptAccessToken: (token: string) => `encrypted:${token}`,
}));

class InMemoryTenantBootstrapStore implements TenantBootstrapStore {
  tenants = new Map<string, { id: string; status: string }>();
  installations = new Map<
    string,
    {
      id: string;
      tenantId: string;
      accessTokenEncrypted: string;
      scopes: string;
      status: string;
      uninstalledAt: Date | null;
    }
  >();
  settings = new Map<string, Map<string, unknown>>();
  roles = new Map<string, Set<string>>();
  onboarding = new Map<string, { status: string; currentStep: string }>();
  jobs = new Map<string, { tenantId: string; status: string }>();

  async findOrCreateActiveTenant(shopDomain: string) {
    const existing = this.tenants.get(shopDomain);

    if (existing) {
      existing.status = "ACTIVE";
      return { id: existing.id };
    }

    const tenant = { id: `tenant-${this.tenants.size + 1}`, status: "ACTIVE" };
    this.tenants.set(shopDomain, tenant);

    return { id: tenant.id };
  }

  async upsertActiveInstallation(input: {
    tenantId: string;
    shopDomain: string;
    accessTokenEncrypted: string;
    scopes: string;
  }) {
    const existing = this.installations.get(input.shopDomain);
    const installation = {
      id: existing?.id ?? `installation-${this.installations.size + 1}`,
      tenantId: input.tenantId,
      accessTokenEncrypted: input.accessTokenEncrypted,
      scopes: input.scopes,
      status: "ACTIVE",
      uninstalledAt: null,
    };

    this.installations.set(input.shopDomain, installation);

    return { id: installation.id };
  }

  async ensureDefaultSettings(
    tenantId: string,
    settings: typeof DEFAULT_TENANT_SETTINGS,
  ) {
    const tenantSettings = this.settings.get(tenantId) ?? new Map();

    for (const [key, value] of Object.entries(settings)) {
      if (!tenantSettings.has(key)) {
        tenantSettings.set(key, value);
      }
    }

    this.settings.set(tenantId, tenantSettings);
  }

  async ensureDefaultRoles(tenantId: string, roles: typeof DEFAULT_ROLE_CODES) {
    const tenantRoles = this.roles.get(tenantId) ?? new Set<string>();

    for (const role of roles) {
      tenantRoles.add(role.code);
    }

    this.roles.set(tenantId, tenantRoles);
  }

  async ensureOnboardingStarted(tenantId: string) {
    if (!this.onboarding.has(tenantId)) {
      this.onboarding.set(tenantId, {
        status: "STARTED",
        currentStep: "WELCOME",
      });
    }
  }

  async markShopUninstalled(shopDomain: string) {
    const installation = this.installations.get(shopDomain);

    if (!installation) {
      return;
    }

    installation.status = "UNINSTALLED";
    installation.uninstalledAt = new Date();

    for (const job of this.jobs.values()) {
      if (
        job.tenantId === installation.tenantId &&
        ["QUEUED", "RUNNING"].includes(job.status)
      ) {
        job.status = "CANCELLED";
      }
    }

    const hasActiveInstallations = [...this.installations.values()].some(
      (candidate) =>
        candidate.tenantId === installation.tenantId &&
        candidate.status === "ACTIVE",
    );

    if (!hasActiveInstallations) {
      const tenant = [...this.tenants.values()].find(
        (candidate) => candidate.id === installation.tenantId,
      );

      if (tenant) {
        tenant.status = "UNINSTALLED";
      }
    }
  }
}

let store: InMemoryTenantBootstrapStore;

beforeEach(() => {
  store = new InMemoryTenantBootstrapStore();
});

describe("tenant bootstrap", () => {
  it("creates tenant bootstrap records for a Shopify shop", async () => {
    const result = await bootstrapTenantFromShopifySession(store, {
      shopDomain: "Example-Shop.myshopify.com",
      accessToken: "secret-token",
      scopes: "write_products",
    });

    expect(result).toEqual({
      tenantId: "tenant-1",
      installationId: "installation-1",
    });
    expect(store.tenants.get("example-shop.myshopify.com")?.status).toBe(
      "ACTIVE",
    );
    expect(
      store.installations.get("example-shop.myshopify.com")
        ?.accessTokenEncrypted,
    ).toBe("encrypted:secret-token");
    expect(store.settings.get("tenant-1")?.size).toBe(
      Object.keys(DEFAULT_TENANT_SETTINGS).length,
    );
    expect(store.roles.get("tenant-1")?.size).toBe(DEFAULT_ROLE_CODES.length);
    expect(store.onboarding.get("tenant-1")).toEqual({
      status: "STARTED",
      currentStep: "WELCOME",
    });
  });

  it("is idempotent on reinstall and updates installation token data", async () => {
    await bootstrapTenantFromShopifySession(store, {
      shopDomain: "example-shop.myshopify.com",
      accessToken: "first-token",
      scopes: "read_products",
    });

    const result = await bootstrapTenantFromShopifySession(store, {
      shopDomain: "example-shop.myshopify.com",
      accessToken: "second-token",
      scopes: "read_products,write_products",
    });

    expect(result).toEqual({
      tenantId: "tenant-1",
      installationId: "installation-1",
    });
    expect(store.tenants.size).toBe(1);
    expect(store.installations.size).toBe(1);
    expect(store.settings.get("tenant-1")?.size).toBe(
      Object.keys(DEFAULT_TENANT_SETTINGS).length,
    );
    expect(
      store.installations.get("example-shop.myshopify.com")
        ?.accessTokenEncrypted,
    ).toBe("encrypted:second-token");
    expect(store.installations.get("example-shop.myshopify.com")?.status).toBe(
      "ACTIVE",
    );
  });

  it("marks a tenant uninstalled when the final shop is uninstalled", async () => {
    await bootstrapTenantFromShopifySession(store, {
      shopDomain: "example-shop.myshopify.com",
      accessToken: "token",
      scopes: "read_products",
    });
    store.jobs.set("job-1", { tenantId: "tenant-1", status: "QUEUED" });

    await store.markShopUninstalled("example-shop.myshopify.com");

    expect(store.installations.get("example-shop.myshopify.com")?.status).toBe(
      "UNINSTALLED",
    );
    expect(store.tenants.get("example-shop.myshopify.com")?.status).toBe(
      "UNINSTALLED",
    );
    expect(store.jobs.get("job-1")?.status).toBe("CANCELLED");
  });
});
