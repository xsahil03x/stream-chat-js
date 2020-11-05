import { getTestClient, getTestClientForUser, sleep } from './utils';
import { v4 as uuidv4 } from 'uuid';
import chai from 'chai';

const expect = chai.expect;

const ruud = { id: `ruud`, role: 'admin' };
const driver = { id: `ruuds-driver`, role: 'admin' };
const driver2 = { id: `ruuds-driver-2`, role: 'admin' };

describe('Location sharing', function () {
	describe('Taxi service', () => {
		let serverClient,
			ruudClient,
			driverClient,
			driver2Client,
			driveRequestChannelID,
			messageWithLocationMap;

		before(async () => {
			serverClient = await getTestClient(true);
			await serverClient.upsertUser(ruud);
			await serverClient.upsertUser(driver);
			await serverClient.upsertUser(driver2);

			ruudClient = await getTestClientForUser(ruud.id);
			driverClient = await getTestClientForUser(driver.id);
			driver2Client = await getTestClientForUser(driver2.id);
		});

		it('Ruud wants to request a ride, server creates a channel', async () => {
			const chan = await serverClient
				.channel('messaging', 'uber-channel-' + uuidv4(), {
					members: [ruud.id],
					created_by_id: ruud.id,
				})
				.create();

			expect(chan.members).to.not.be.undefined;
			expect(chan.members).to.have.lengthOf(1);
			expect(chan.members[0].user.id).to.equal(ruud.id);

			driveRequestChannelID = chan.channel.id;
		});

		it('Ruud shares static location with channel', async () => {
			let static_location = { lon: 50.0, lat: 51.0, accuracy: 20 };
			let location_map = { static_pointers: [static_location] };
			let msg = {
				text: "here's my location, please pick me up",
				attachments: [{ location_map }],
			};

			// Ruud sends message with location map to channel
			const ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			const res = await ruudChannel.sendMessage(msg);
			expect(res.message).to.not.be.undefined;
			expect(res.message.attachments).to.not.be.undefined;
			expect(res.message.attachments.length).to.be.greaterThan(0);

			let resLocationMap = res.message.attachments[0].location_map;
			expect(resLocationMap).to.not.be.undefined;
			expect(resLocationMap.static_pointers).to.not.be.undefined;
			expect(resLocationMap.static_pointers.length).to.be.greaterThan(0);
			expect(resLocationMap.static_pointers[0].lon).to.equal(50.0);
			expect(resLocationMap.static_pointers[0].lat).to.equal(51.0);
			expect(resLocationMap.static_pointers[0].accuracy).to.equal(20);

			messageWithLocationMap = res.message;
		});

		it("Driver is assigned and added to Ruud's channel by the server", async () => {
			await serverClient
				.channel('messaging', driveRequestChannelID)
				.addMembers([driver.id]);
		});

		it("Driver shares live location to Ruud's channel", async () => {
			const driverChannel = driverClient.channel(
				'messaging',
				driveRequestChannelID,
			);
			const ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			await ruudChannel.watch();

			let driverStartedSharing = new Promise((success) => {
				ruudChannel.on('location.sharing_started', () => {
					success();
				});
			});

			// Driver shares live location
			let live_location = { accuracy: 20, lat: 51.0, lon: 50.0 };
			driverChannel.shareLiveLocation(live_location, 15).then((res) => {
				expect(res.location).to.not.be.undefined;
				expect(res.location.accuracy).to.equal(20);
				expect(res.location.lat).to.equal(51.0);
				expect(res.location.lon).to.equal(50.0);
				expect(res.location.updated_at).to.not.be.undefined;
			});

			// Wait for ruud's channel to receive notice that the driver started sharing the location
			await driverStartedSharing;

			let driverLocation = ruudChannel.state.live_locations[driver.id];
			expect(driverLocation).to.not.be.undefined;
			expect(driverLocation.accuracy).to.equal(20);
			expect(driverLocation.lat).to.equal(51.0);
			expect(driverLocation.lon).to.equal(50.0);
			expect(driverLocation.updated_at).to.not.be.undefined;

			// Add the live location to the message with the locationMap
			messageWithLocationMap.attachments[0].location_map.live_users.push(driver.id);
			const res = await driverClient.updateMessage({ ...messageWithLocationMap });

			expect(res.message).to.not.be.undefined;
			expect(res.message.attachments).to.not.be.undefined;
			expect(res.message.attachments.length).to.be.greaterThan(0);
			let resLocationMap = res.message.attachments[0].location_map;
			expect(resLocationMap.live_users).to.not.be.undefined;
			expect(resLocationMap.live_users.length).to.equal(1);
			expect(resLocationMap.live_users[0]).to.equal(driver.id);
			expect(resLocationMap.static_pointers).to.not.be.undefined;
			expect(resLocationMap.static_pointers.length).to.equal(1);
		});

		it('Ride is cancelled, driver stops sharing location', async () => {
			const driverChannel = driverClient.channel(
				'messaging',
				driveRequestChannelID,
			);

			const ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			const state = await ruudChannel.watch();
			expect(state.live_locations[driver.id]).to.not.be.undefined;

			let driverStoppedSharing = new Promise((success) => {
				ruudChannel.on('location.sharing_stopped', () => {
					success();
				});
			});

			// Stop sharing location
			await driverChannel.stopLiveLocation();

			// Wait for ruud's channel to receive notice that driver stopped sharing location
			await driverStoppedSharing;

			if (ruudChannel.state.live_locations !== null) {
				expect(ruudChannel.state.live_locations[driver.id]).to.be.undefined;
			}
		});

		it('Ruud finds another ride with driver2', async () => {
			// Server adds to new channel
			const chan = await serverClient
				.channel('messaging', 'uber-channel-' + uuidv4(), {
					members: [ruud.id, driver2.id],
					created_by_id: ruud.id,
				})
				.create();

			driveRequestChannelID = chan.channel.id;

			// Get channel for Driver2
			let driver2Channel = driver2Client.channel(
				'messaging',
				driveRequestChannelID,
			);
			await driver2Channel.watch();

			// Get channel for Ruud
			let ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			await ruudChannel.watch();

			let driver2StartedSharing = new Promise((success) => {
				ruudChannel.on('location.sharing_started', () => {
					success();
				});
			});

			// Driver 2 shares location
			let driver2Location = { lon: 55, lat: 55, accuracy: 20 };
			await driver2Channel.shareLiveLocation(driver2Location, 20);

			// Ruud got notified that driver 2 is sharing their location
			await driver2StartedSharing;

			expect(ruudChannel.state.live_locations).to.not.be.null;
			expect(Object.keys(ruudChannel.state.live_locations)).to.have.lengthOf(1);
		});

		it('Ruud wants to share his live location too', async () => {
			// Get channel for Ruud
			let ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			let ruudState = await ruudChannel.watch();

			// Get channel for Driver2
			let driver2Channel = driver2Client.channel(
				'messaging',
				driveRequestChannelID,
			);
			let driver2State = await driver2Channel.watch();

			expect(ruudState.live_locations).to.not.be.null;
			expect(Object.keys(ruudState.live_locations)).to.have.lengthOf(1);

			expect(driver2State.live_locations).to.not.be.null;
			expect(Object.keys(driver2State.live_locations)).to.have.lengthOf(1);

			let ruudStartedSharing = new Promise((success) => {
				driver2Channel.on('location.sharing_started', () => {
					success();
				});
			});

			// share location
			let ruudLocation = { lon: 45, lat: 45, accuracy: 10 };
			await ruudChannel.shareLiveLocation(ruudLocation, 20);

			// driver 2 receives event that ruud started sharing
			await ruudStartedSharing;

			expect(ruudChannel.state.live_locations).to.not.be.null;
			expect(Object.keys(ruudChannel.state.live_locations)).to.have.lengthOf(2);
			expect(driver2Channel.state.live_locations).to.not.be.null;
			expect(Object.keys(driver2Channel.state.live_locations)).to.have.lengthOf(2);
		});

		it('Driver2 drops Ruud off at correct location', async () => {
			// Get channel for Driver2
			let driver2Channel = driver2Client.channel(
				'messaging',
				driveRequestChannelID,
			);
			await driver2Channel.watch();

			// Get channel for Ruud
			let ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			await ruudChannel.watch();

			let driver2StoppedSharing = new Promise((success) => {
				ruudChannel.on('location.sharing_stopped', () => {
					success();
				});
			});

			// Stop sharing for both users
			await driver2Channel.stopLiveLocation();
			await driver2StoppedSharing;

			expect(ruudChannel.state.live_locations).to.not.be.null;
			expect(Object.keys(ruudChannel.state.live_locations)).to.have.lengthOf(1);
			expect(driver2Channel.state.live_locations).to.not.be.null;
			expect(Object.keys(driver2Channel.state.live_locations)).to.have.lengthOf(1);
		});
	});
});
