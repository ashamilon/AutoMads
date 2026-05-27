import ModulePlaceholder from "./ModulePlaceholder";

export default function ProductGrid({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="product_grid"
      title="Product Grid"
      tenantId={tenantId}
      category="universal"
    />
  );
}
