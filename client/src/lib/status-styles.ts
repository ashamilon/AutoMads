export type Tone = "default" | "success" | "warning" | "danger" | "info";

export function orderStatusTone(status: string): Tone {
  switch (status) {
    case "COMPLETED":
    case "PAID":
      return "success";
    case "FAILED":
    case "CANCELLED":
      return "danger";
    case "AWAITING_PAYMENT":
    case "PENDING_CLIENT_SYNC":
      return "warning";
    default:
      return "info";
  }
}

export function paymentTone(s: string): Tone {
  if (s === "PAID") return "success";
  if (s === "FAILED" || s === "REFUNDED") return "danger";
  return "warning";
}
