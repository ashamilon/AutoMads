import ModulePlaceholder from "./ModulePlaceholder";

export default function ShoeSizeChart({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="shoe_size_chart"
      title="Shoe Size Chart"
      tenantId={tenantId}
      category="shoes"
    />
  );
}
