import ModulePlaceholder from "./ModulePlaceholder";

export default function TeamFilter({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="team_filter"
      title="Team Filter"
      tenantId={tenantId}
      category="jersey"
    />
  );
}
