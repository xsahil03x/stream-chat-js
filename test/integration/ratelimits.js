import chai from 'chai';
import { getTestClient, getTestClientForUser } from './utils';
const expect = chai.expect;

describe('Ratelimits v2', () => {
	const userID = 'ruud';
	const client = getTestClient(true);

	const newResponseHeaderInterceptor = (userClient) =>
		new Promise((res) => {
			userClient.logger = (logLevel, message, extraData) => {
				if (extraData && extraData.response && extraData.response.headers) {
					res(extraData.response.headers);
				}
			};
		});

	const parseRatelimitHeaders = (headers) => [
		parseInt(headers['x-ratelimit-reset']),
		parseInt(headers['x-ratelimit-limit']),
		parseInt(headers['x-ratelimit-remaining']),
	];

	before(async () => {
		await client.upsertUser({
			id: userID,
		});
	});

	describe('api response headers', () => {
		let userClient;

		before(async () => {
			userClient = await getTestClientForUser(userID);
		});

		it('should contain ratelimit headers', async () => {
			let firstLimit = 0;
			for (let i = 1; i <= 10; i++) {
				const [responseHeaders] = await Promise.all([
					newResponseHeaderInterceptor(userClient),
					userClient.queryChannels({ members: { $in: [userID] } }),
				]);

				const [reset, limit, remaining] = parseRatelimitHeaders(responseHeaders);
				firstLimit = firstLimit ? firstLimit : limit;
				expect(reset).to.be.greaterThan(1610000000);
				expect(limit).to.be.greaterThan(50);
				expect(remaining).to.equal(firstLimit - i);
			}
		});
	});
});
