import ModulePlaceholder from "./ModulePlaceholder";

export default function SizeChart({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="size_chart"
      title="Size Chart"
      tenantId={tenantId}
      category="jersey"
    />
  );
}
