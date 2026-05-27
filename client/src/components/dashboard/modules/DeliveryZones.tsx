import ModulePlaceholder from "./ModulePlaceholder";

export default function DeliveryZones({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="delivery_zones"
      title="Delivery Zones"
      tenantId={tenantId}
      category="restaurant"
    />
  );
}
