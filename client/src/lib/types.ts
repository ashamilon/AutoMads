export type TenantMe = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  facebookPageId: string | null;
  hasFacebookPageAccessToken: boolean;
  settings: Record<string, unknown> | null;
  onboardingCompletedAt: string | null;
  businessCategory: string | null;
  integration: {
    type: string;
    config: Record<string, unknown>;
  } | null;
};

export type OrderRow = {
  id: string;
  messengerPsid: string;
  structuredData: Record<string, unknown>;
  status: string;
  paymentStatus: string;
  deliveryStatus: string;
  externalOrderId: string | null;
  sslcommerzTranId: string | null;
  pathaoConsignmentId: string | null;
  totalAmount: string | null;
  currency: string;
  failureReason: string | null;
  paymentMethod: string;
  manualTxnId: string | null;
  manualPaymentNote: string | null;
  manuallyVerifiedBy: string | null;
  manuallyVerifiedAt: string | null;
  invoiceUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductMappingRow = {
  id: string;
  clientSku: string;
  facebookLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};
