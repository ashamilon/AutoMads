import ModulePlaceholder from "./ModulePlaceholder";

export default function FoodVariants({ tenantId }: { tenantId: string }) {
  return (
    <ModulePlaceholder
      moduleId="food_variants"
      title="Food Variants"
      tenantId={tenantId}
      category="restaurant"
    />
  );
}
