// The package's own name and version, sent in the User-Agent of every request
// so the API's logs can tell calls made through this package from any other
// caller. Kept equal to package.json by version.test.ts.
export const PACKAGE_NAME = "doc-cheap-ai-sdk";
export const PACKAGE_VERSION = "0.1.1";
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
