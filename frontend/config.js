/* Runtime config for the storefront. Rewrite this file per environment at deploy time.
   apiBase: origin of the backend API. Leave empty when the API is served from the same
   origin (local dev, or CloudFront routing /api/* to the ALB).
   paymentTimeoutMinutes (optional): minutes before an unpaid order is cancelled; shows a countdown on
   the PayNow screen. The AWS deploy writes its own copy of this file (infra/terraform/cdn.tf). */
window.KK_CONFIG = {
  apiBase: '',
};
