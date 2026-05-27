import ModulePlaceholder from "./ModulePlaceholder";

export default function MenuManager({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="menu_manager"
      title="Menu Manager"
      tenantId={tenantId}
      category="restaurant"
    />
  );
}
