import ModulePlaceholder from "./ModulePlaceholder";

export default function IngredientsPanel({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="ingredients_panel"
      title="Ingredients Panel"
      tenantId={tenantId}
      category="cosmetics"
    />
  );
}
