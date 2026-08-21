import { handleCsvProductizationApiRoute as handleCoreCsvProductizationApiRoute } from './csv-productization-api-core.js';
import { handleCsvRecommendationHumanReviewPersistenceRoute } from './csv-recommendation-human-review-api.js';

export async function handleCsvProductizationApiRoute(args) {
  const reviewResponse = await handleCsvRecommendationHumanReviewPersistenceRoute(args);
  if (reviewResponse) return reviewResponse;
  return handleCoreCsvProductizationApiRoute(args);
}
