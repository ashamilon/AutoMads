import type { ComponentType } from "react";

import AnalyticsPanel from "./modules/AnalyticsPanel";
import ConversationsPanel from "./modules/ConversationsPanel";
import DeliveryZones from "./modules/DeliveryZones";
import FoodVariants from "./modules/FoodVariants";
import GenderFilter from "./modules/GenderFilter";
import IngredientsPanel from "./modules/IngredientsPanel";
import MenuManager from "./modules/MenuManager";
import OrdersTable from "./modules/OrdersTable";
import PlayerFilter from "./modules/PlayerFilter";
import ProductGrid from "./modules/ProductGrid";
import ShadeSelector from "./modules/ShadeSelector";
import ShoeSizeChart from "./modules/ShoeSizeChart";
import SizeChart from "./modules/SizeChart";
import SkinTypeFilter from "./modules/SkinTypeFilter";
import TeamFilter from "./modules/TeamFilter";

/**
 * Literal union of every dashboard module id known to the platform.
 *
 * Universal modules are rendered by every category; the rest are wired up by
 * `categorySchema.dashboardModules` per the Category Engine.
 */
export type DashboardModuleId =
  // Universal
  | "product_grid"
  | "orders_table"
  | "conversations_panel"
  | "analytics_panel"
  // Jersey
  | "size_chart"
  | "team_filter"
  | "player_filter"
  // Restaurant
  | "menu_manager"
  | "delivery_zones"
  | "food_variants"
  // Cosmetics
  | "shade_selector"
  | "skin_type_filter"
  | "ingredients_panel"
  // Shoes
  | "shoe_size_chart"
  | "gender_filter";

export type DashboardModuleComponent = ComponentType<{ tenantId: string }>;

/**
 * Single source of truth mapping a moduleId to a React component. The
 * `DashboardModuleRenderer` looks each id up here when rendering the modules
 * declared by a tenant's `categorySchema.dashboardModules` list.
 *
 * Keys are typed with `DashboardModuleId` so the registry stays exhaustive at
 * compile time. Adding a new module means: (1) implement the component under
 * `./modules/`, (2) extend the `DashboardModuleId` union, (3) register it
 * here. TypeScript will flag any missing entry.
 */
export const dashboardModuleRegistry: Map<
  DashboardModuleId,
  DashboardModuleComponent
> = new Map<DashboardModuleId, DashboardModuleComponent>([
  // Universal
  ["product_grid", ProductGrid],
  ["orders_table", OrdersTable],
  ["conversations_panel", ConversationsPanel],
  ["analytics_panel", AnalyticsPanel],
  // Jersey
  ["size_chart", SizeChart],
  ["team_filter", TeamFilter],
  ["player_filter", PlayerFilter],
  // Restaurant
  ["menu_manager", MenuManager],
  ["delivery_zones", DeliveryZones],
  ["food_variants", FoodVariants],
  // Cosmetics
  ["shade_selector", ShadeSelector],
  ["skin_type_filter", SkinTypeFilter],
  ["ingredients_panel", IngredientsPanel],
  // Shoes
  ["shoe_size_chart", ShoeSizeChart],
  ["gender_filter", GenderFilter],
]);

/**
 * Resolve a moduleId against the registry. Returns `undefined` when the
 * module is not registered so callers can decide whether to skip-and-warn or
 * throw.
 */
export function resolveDashboardModule(
  moduleId: string,
): DashboardModuleComponent | undefined {
  return dashboardModuleRegistry.get(moduleId as DashboardModuleId);
}

/**
 * Type guard used by the renderer to narrow an arbitrary string (coming from
 * `categorySchema.dashboardModules`) to a known `DashboardModuleId`.
 */
export function isKnownDashboardModuleId(
  moduleId: string,
): moduleId is DashboardModuleId {
  return dashboardModuleRegistry.has(moduleId as DashboardModuleId);
}
