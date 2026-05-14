import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

export type OrderDecision = "create_order" | "skip_order_create";

type OrderDecisionInput = {
  catalogIntent: "ask_order" | "ask_photo" | "ask_size_chart" | "ask_price_stock" | "ask_checkout_policy" | "general";
  isClarificationQuestion: boolean;
  looksLikeDetailsSupply: boolean;
  hasOrderConfirmationVerb: boolean;
  hasStructured: boolean;
  validationOk: boolean;
};

const DecisionState = Annotation.Root({
  input: Annotation<OrderDecisionInput>(),
  shouldAttempt: Annotation<boolean>(),
  decision: Annotation<OrderDecision>(),
});

const orderDecisionGraph = new StateGraph(DecisionState)
  .addNode("precheck", (state) => {
    const i = state.input;
    const shouldAttempt =
      i.catalogIntent === "ask_order" &&
      !i.isClarificationQuestion &&
      (i.looksLikeDetailsSupply || i.hasOrderConfirmationVerb);
    return { shouldAttempt };
  })
  .addNode("create", () => ({ decision: "create_order" as const }))
  .addNode("skip", () => ({ decision: "skip_order_create" as const }))
  .addEdge(START, "precheck")
  .addConditionalEdges("precheck", (state) => (state.shouldAttempt ? "create" : "skip"), {
    create: "create",
    skip: "skip",
  })
  .addEdge("create", END)
  .addEdge("skip", END)
  .compile();

export async function decideOrderCreate(input: OrderDecisionInput): Promise<OrderDecision> {
  const out = await orderDecisionGraph.invoke({
    input,
    shouldAttempt: false,
    decision: "skip_order_create",
  });
  return out.decision;
}

