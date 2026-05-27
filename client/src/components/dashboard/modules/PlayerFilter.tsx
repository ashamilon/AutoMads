import ModulePlaceholder from "./ModulePlaceholder";

export default function PlayerFilter({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="player_filter"
      title="Player Filter"
      tenantId={tenantId}
      category="jersey"
    />
  );
}
