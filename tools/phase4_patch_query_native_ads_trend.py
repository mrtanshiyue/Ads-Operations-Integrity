from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


main_path = Path('assets/generated/inline-script-04.js')
main = main_path.read_text(encoding='utf-8')
main = replace_once(
    main,
    'const renderTrend = rows => {\n  if(!rows?.length)return;',
    'const renderTrend = rows => {\n  if(window.QueryNativeAdsTrend?.ownsTrend?.()){void window.QueryNativeAdsTrend.renderFromHost?.();return;}\n  if(!rows?.length)return;',
    'trend delegation',
)
main = replace_once(
    main,
    '    getTransactionRowsForFinance:()=>AdsStore.transactions,\n',
    '    getTransactionRowsForFinance:()=>AdsStore.transactions,\n    getAdsRowsForQueryCompatibility:()=>AdsStore.all,\n',
    'ads Raw compatibility getter',
)
main_path.write_text(main, encoding='utf-8')

index_path = Path('index.html')
index = index_path.read_text(encoding='utf-8')
index = replace_once(
    index,
    'assets/query-native-module-data-v1.js?v=1.0.0',
    'assets/query-native-module-data-v1.js?v=1.1.0',
    'adapter version',
)
index = replace_once(
    index,
    '<script id="queryNativeModuleDataV1" src="assets/query-native-module-data-v1.js?v=1.1.0"></script>\n<script id="transaction-finance-report-script" src="assets/generated/inline-script-08.js?v=2.0.0"></script>',
    '<script id="queryNativeModuleDataV1" src="assets/query-native-module-data-v1.js?v=1.1.0"></script>\n<script id="queryNativeAdsTrendV1" src="assets/query-native-ads-trend-v1.js?v=1.0.0"></script>\n<script id="transaction-finance-report-script" src="assets/generated/inline-script-08.js?v=2.0.0"></script>',
    'ads trend script registration',
)
index_path.write_text(index, encoding='utf-8')

print('Phase 4 Query-native ads trend patch applied')
