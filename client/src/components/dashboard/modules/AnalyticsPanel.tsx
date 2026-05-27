import ModulePlaceholder from "./ModulePlaceholder";

export default function AnalyticsPanel({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="analytics_panel"
      title="Analytics"
      tenantId={tenantId}
      category="universal"
    />
  );
}
