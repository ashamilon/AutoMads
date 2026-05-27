import ModulePlaceholder from "./ModulePlaceholder";

export default function ShadeSelector({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="shade_selector"
      title="Shade Selector"
      tenantId={tenantId}
      category="cosmetics"
    />
  );
}
