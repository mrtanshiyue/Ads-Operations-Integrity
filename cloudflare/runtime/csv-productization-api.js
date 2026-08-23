import { handleCsvProductizationApiRoute as handleCoreCsvProductizationApiRoute } from './csv-productization-api-core.js';
import { handleCsvRecommendationHumanReviewPersistenceRoute } from './csv-recommendation-human-review-api.js';
import { handleCsvImportAuthorityApiRoute } from './csv-import-authority-api.js';

export async function handleCsvProductizationApiRoute(args) {
  const reviewResponse = await handleCsvRecommendationHumanReviewPersistenceRoute(args);
  if (reviewResponse) return reviewResponse;
  const authorityResponse = await handleCsvImportAuthorityApiRoute(args);
  if (authorityResponse) return authorityResponse;
  return handleCoreCsvProductizationApiRoute(args);
}
