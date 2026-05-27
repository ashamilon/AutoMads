/**
 * MarketplaceAdapter — interface-only contract for external commerce
 * marketplaces (Shopify today's planned integration, Daraz next).
 *
 * Concrete adapters will live alongside this file in later tasks. For now
 * this module only declares the surface so dependent code can be typed
 * against the abstraction.
 *
 * Maps to: Requirements 21.1, 21.3, 21.4.
 */

export type MarketplaceId = 'shopify' | 'daraz';

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;

  /**
   * Push the tenant's catalog up to the marketplace, creating new SKUs and
   * updating existing ones. Implementations MUST scope every read/write by
   * `tenantId`.
   */
  syncProducts(
    tenantId: string,
  ): Promise<{ added: number; updated: number; failed: number }>;

  /**
   * Forward a single order to the marketplace. Implementations return the
   * marketplace's `externalId` on success so the local order row can store
   * the cross-reference.
   */
  pushOrder(
    tenantId: string,
    orderId: string,
  ): Promise<{ ok: boolean; externalId?: string; reason?: string }>;
}
