/* Runtime config for the storefront. Rewrite this file per environment at deploy time.
   apiBase: origin of the backend API. Leave empty when the API is served from the same
   origin (local dev, or CloudFront routing /api/* to the ALB). */
window.KK_CONFIG = {
  apiBase: '',
};
