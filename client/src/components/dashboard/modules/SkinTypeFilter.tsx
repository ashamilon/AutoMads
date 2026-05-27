import ModulePlaceholder from "./ModulePlaceholder";

export default function SkinTypeFilter({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="skin_type_filter"
      title="Skin Type Filter"
      tenantId={tenantId}
      category="cosmetics"
    />
  );
}
