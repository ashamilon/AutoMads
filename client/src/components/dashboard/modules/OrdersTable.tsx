import ModulePlaceholder from "./ModulePlaceholder";

export default function OrdersTable({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="orders_table"
      title="Orders Table"
      tenantId={tenantId}
      category="universal"
    />
  );
}
