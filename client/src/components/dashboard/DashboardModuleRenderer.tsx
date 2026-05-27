import { Fragment } from "react";

import {
  type DashboardModuleId,
  resolveDashboardModule,
} from "./ModuleRegistry";
import UpgradePrompt from "./UpgradePrompt";

export interface DashboardModuleRendererProps {
  /** Tenant whose dashboard is being rendered. Forwarded to every module. */
  tenantId: string;
  /**
   * Module ids drawn from `categorySchema.dashboardModules`. Order is
   * preserved when rendering. Strings are accepted (rather than
   * `DashboardModuleId[]`) because the value comes from JSON at runtime; the
   * renderer skips and warns on unknown ids per spec R4.5.
   */
  modules: readonly string[];
  /**
   * Optional resolved feature-flag map keyed by moduleId. When the value is
   * `false` the module is hidden and replaced with an upgrade prompt. Missing
   * keys are treated as enabled (`true`) — the page is responsible for
   * fetching flags and passing them down per task 13.2's scope.
   */
  featureFlags?: Readonly<Record<string, boolean>>;
}

/**
 * Renders dashboard modules listed by `categorySchema.dashboardModules` in
 * declared order.
 *
 * Behaviour:
 * - Unknown moduleId → skip and emit `console.warn('dashboard_module_missing',
 *   { tenantId, moduleId })` (spec R4.5).
 * - `featureFlags[moduleId] === false` → render `<UpgradePrompt />` linking to
 *   `/portal/billing` (spec R16.3) instead of the module.
 * - Otherwise → render the registered component with `{ tenantId }`.
 *
 * The same render path is used by `localhost:3000/admin` and
 * `dashboard.pipwarp.com` because both surfaces share this Next.js code base
 * (spec R4.6, R17.4).
 */
export function DashboardModuleRenderer({
  tenantId,
  modules,
  featureFlags,
}: DashboardModuleRendererProps) {
  return (
    <Fragment>
      {modules.map((moduleId, index) => {
        const Component = resolveDashboardModule(moduleId);
        if (!Component) {
          // Skip-and-warn path: keeps the dashboard rendering even when the
          // active schema declares a module the registry does not yet know.
          // Logged structured-style so it is greppable in operator consoles.
          // eslint-disable-next-line no-console
          console.warn("dashboard_module_missing", { tenantId, moduleId });
          return null;
        }

        const flag = featureFlags?.[moduleId];
        if (flag === false) {
          return (
            <UpgradePrompt
              key={`${moduleId}-${index}`}
              moduleId={moduleId}
              title={prettifyModuleId(moduleId as DashboardModuleId | string)}
            />
          );
        }

        return (
          <Component
            key={`${moduleId}-${index}`}
            tenantId={tenantId}
          />
        );
      })}
    </Fragment>
  );
}

function prettifyModuleId(moduleId: string): string {
  return moduleId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default DashboardModuleRenderer;
