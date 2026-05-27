import ModulePlaceholder from "./ModulePlaceholder";

export default function ConversationsPanel({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="conversations_panel"
      title="Conversations"
      tenantId={tenantId}
      category="universal"
    />
  );
}
