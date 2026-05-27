import ModulePlaceholder from "./ModulePlaceholder";

export default function GenderFilter({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="gender_filter"
      title="Gender Filter"
      tenantId={tenantId}
      category="shoes"
    />
  );
}
