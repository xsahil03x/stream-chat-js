import { getTestClient, getTestClientForUser, sleep } from './utils';
import { v4 as uuidv4 } from 'uuid';
import chai from 'chai';

const expect = chai.expect;

const ruud = { id: `ruud` };
const driver = { id: `ruuds-driver` };
const driver2 = { id: `ruuds-driver-2` };
const friend = { id: `ruuds-friend` };
const friend2 = { id: `ruuds-friend2` };

const equalLocations = (location1, location2) => {
	expect(typeof location1).to.equal(typeof location2);

	if (location1 && location2) {
		expect(location1.lat).to.equal(location2.lat);
		expect(location1.lon).to.equal(location2.lon);
		expect(location1.accuracy).to.equal(location2.accuracy);
	}
};

const eventPromise = (channel, event) => {
	return new Promise((success) => {
		channel.on(event, () => {
			success();
		});
	});
};

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
			equalLocations(resLocationMap.static_pointers[0], static_location);

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

			let driverStartedSharing = eventPromise(
				ruudChannel,
				'location.sharing_started',
			);

			// Driver shares live location
			let live_location = { accuracy: 20, lat: 51.0, lon: 50.0 };
			driverChannel.shareLiveLocation(live_location, 15).then((res) => {
				expect(res.location).to.not.be.undefined;
				expect(res.location.updated_at).to.not.be.undefined;
				equalLocations(res.location, live_location);
			});

			// Wait for ruud's channel to receive notice that the driver started sharing the location
			await driverStartedSharing;

			let driverLocation = ruudChannel.state.live_locations[driver.id];
			expect(driverLocation).to.not.be.undefined;
			expect(driverLocation.updated_at).to.not.be.undefined;
			equalLocations(driverLocation, live_location);

			// Add the live location to the message with the locationMap
			messageWithLocationMap.attachments[0].location_map.live_users.push(driver.id);
			const res = await serverClient.updateMessage({
				...messageWithLocationMap,
				user_id: ruud.id,
			});

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

			let driverStoppedSharing = eventPromise(
				ruudChannel,
				'location.sharing_stopped',
			);

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

			let driver2StartedSharing = eventPromise(
				ruudChannel,
				'location.sharing_started',
			);

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

			let ruudStartedSharing = eventPromise(
				driver2Channel,
				'location.sharing_started',
			);

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

		it('Ruud and Driver2 update their location a few times during the ride', async () => {
			// Get channel for Driver2
			let driver2Channel = driver2Client.channel(
				'messaging',
				driveRequestChannelID,
			);
			await driver2Channel.watch();

			// Get channel for Ruud
			let ruudChannel = ruudClient.channel('messaging', driveRequestChannelID);
			await ruudChannel.watch();

			// Ruud and Driver2 update their location 10 times during the trip
			let ruudLiveLocation, driver2Location;
			for (let i = 0; i < 10; i++) {
				let ruudUpdatedLocation = eventPromise(
					driver2Channel,
					'location.updated',
				);

				ruudLiveLocation = { lon: 40.0 + i, lat: 40.0 + i, accuracy: 5 + i };
				await ruudClient.updateLiveLocation(ruudLiveLocation);

				await ruudUpdatedLocation;

				let locationInRuudsState = ruudChannel.state.live_locations[ruud.id];
				expect(locationInRuudsState).to.not.be.undefined;
				equalLocations(locationInRuudsState, ruudLiveLocation);

				let locationInDriver2State = driver2Channel.state.live_locations[ruud.id];
				expect(locationInDriver2State).to.not.be.undefined;
				equalLocations(locationInDriver2State, ruudLiveLocation);

				// Driver 2 updates location
				let driver2UpdatedLocation = eventPromise(
					ruudChannel,
					'location.updated',
				);
				driver2Location = { lon: 60.0 + i, lat: 60.0 + i, accuracy: 25 + i };
				await driver2Client.updateLiveLocation(driver2Location);

				await driver2UpdatedLocation;

				let driver2LocationInRuudsState =
					ruudChannel.state.live_locations[driver2.id];
				equalLocations(driver2LocationInRuudsState, driver2Location);

				let driver2LocationInDriver2State =
					driver2Channel.state.live_locations[driver2.id];
				expect(driver2LocationInDriver2State).to.not.be.undefined;
				equalLocations(driver2LocationInDriver2State, driver2Location);
			}

			// Latest locations should be set when querying the state
			let driver2State = await driver2Channel.watch();
			let ruudState = await ruudChannel.watch();

			expect(Object.keys(driver2State.live_locations).length).to.equal(2);
			expect(Object.keys(ruudState.live_locations).length).to.equal(2);
			equalLocations(driver2State.live_locations[ruud.id], ruudLiveLocation);
			equalLocations(driver2State.live_locations[driver2.id], driver2Location);
			equalLocations(ruudState.live_locations[ruud.id], ruudLiveLocation);
			equalLocations(ruudState.live_locations[driver2.id], driver2Location);
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

			let driver2StoppedSharing = eventPromise(
				ruudChannel,
				'location.sharing_stopped',
			);

			// Stop sharing for both users
			await driver2Channel.stopLiveLocation();
			await driver2StoppedSharing;

			expect(ruudChannel.state.live_locations).to.not.be.null;
			expect(Object.keys(ruudChannel.state.live_locations)).to.have.lengthOf(1);
			expect(driver2Channel.state.live_locations).to.not.be.null;
			expect(Object.keys(driver2Channel.state.live_locations)).to.have.lengthOf(1);

			let ruudStoppedSharing = eventPromise(
				driver2Channel,
				'location.sharing_stopped',
			);

			await ruudChannel.stopLiveLocation();
			await ruudStoppedSharing;

			expect(ruudChannel.state.live_locations).to.be.empty;
			expect(driver2Channel.state.live_locations).to.be.empty;

			// Location should be empty when querying channel
			let driver2State = await driver2Channel.watch();
			let ruudState = await ruudChannel.watch();

			if (
				driver2State.live_locations !== null &&
				ruudState.live_locations !== null
			) {
				expect(driver2State.live_locations).to.be.empty;
				expect(ruudState.live_locations).to.be.empty;
			}
		});
	});

	describe('Messenger', () => {
		let serverClient,
			ruudClient,
			friendClient,
			friend2Client,
			privateChannelWithFriend,
			privateChannelWithFriend2,
			sharedChannelWithFriends,
			ruudChannelWithFriend,
			ruudChannelWithFriend2,
			ruudSharedChannel,
			friendChannelWithRuud,
			friend2ChannelWithRuud,
			friendSharedChannel,
			friend2SharedChannel;

		before(async () => {
			serverClient = await getTestClient(true);
			await serverClient.upsertUser(ruud);
			await serverClient.upsertUser(friend);
			await serverClient.upsertUser(friend2);

			ruudClient = await getTestClientForUser(ruud.id);
			friendClient = await getTestClientForUser(friend.id);
			friend2Client = await getTestClientForUser(friend2.id);

			privateChannelWithFriend = 'private-friend-' + uuidv4();
			privateChannelWithFriend2 = 'private-friend2-' + uuidv4();
			sharedChannelWithFriends = 'shared-friends-' + uuidv4();

			await serverClient
				.channel('messaging', privateChannelWithFriend, {
					members: [ruud.id, friend.id],
					created_by_id: friend.id,
				})
				.create();

			await serverClient
				.channel('messaging', privateChannelWithFriend2, {
					members: [ruud.id, friend2.id],
					created_by_id: friend2.id,
				})
				.create();

			await serverClient
				.channel('messaging', sharedChannelWithFriends, {
					members: [ruud.id, friend.id, friend2.id],
					created_by_id: ruud.id,
				})
				.create();

			// Ruuds channels
			ruudChannelWithFriend = ruudClient.channel(
				'messaging',
				privateChannelWithFriend,
			);
			await ruudChannelWithFriend.watch();

			ruudChannelWithFriend2 = ruudClient.channel(
				'messaging',
				privateChannelWithFriend2,
			);
			await ruudChannelWithFriend2.watch();

			ruudSharedChannel = ruudClient.channel('messaging', sharedChannelWithFriends);
			await ruudSharedChannel.watch();

			// Friends channels
			friendChannelWithRuud = friendClient.channel(
				'messaging',
				privateChannelWithFriend,
			);
			await friendChannelWithRuud.watch();

			friendSharedChannel = friendClient.channel(
				'messaging',
				sharedChannelWithFriends,
			);
			await friendSharedChannel.watch();

			// Friend2 channels
			friend2ChannelWithRuud = friend2Client.channel(
				'messaging',
				privateChannelWithFriend2,
			);
			await friend2ChannelWithRuud.watch();

			friend2SharedChannel = friend2Client.channel(
				'messaging',
				sharedChannelWithFriends,
			);
			await friend2SharedChannel.watch();
		});

		it('Ruud shares live location with friend', async () => {
			let ruudsLocation = { lon: 70, lat: 70, accuracy: 7 };
			let ruudStartsSharing = eventPromise(
				friendChannelWithRuud,
				'location.sharing_started',
			);
			await Promise.all([
				ruudChannelWithFriend.shareLiveLocation(ruudsLocation, 7),
				ruudStartsSharing,
			]);
			equalLocations(
				friendChannelWithRuud.state.live_locations[ruud.id],
				ruudsLocation,
			);
			equalLocations(
				ruudChannelWithFriend.state.live_locations[ruud.id],
				ruudsLocation,
			);
		});

		it('Ruud also shares live location with friend2', async () => {
			let ruudsLocation = { lon: 80, lat: 80, accuracy: 8 };
			let ruudStartsSharing = eventPromise(
				friend2ChannelWithRuud,
				'location.sharing_started',
			);
			await Promise.all([
				ruudChannelWithFriend2.shareLiveLocation(ruudsLocation, 7),
				ruudStartsSharing,
			]);
			equalLocations(
				friend2ChannelWithRuud.state.live_locations[ruud.id],
				ruudsLocation,
			);
			equalLocations(
				ruudChannelWithFriend2.state.live_locations[ruud.id],
				ruudsLocation,
			);
		});

		it('Ruud also shares live location in shared channel', async () => {
			let ruudsLocation = { lon: 80, lat: 80, accuracy: 8 };

			let ruudStartsSharingFriend = eventPromise(
				friendSharedChannel,
				'location.sharing_started',
			);
			let ruudStartsSharingFriend2 = eventPromise(
				friend2SharedChannel,
				'location.sharing_started',
			);
			let share = ruudSharedChannel.shareLiveLocation(ruudsLocation, 8);
			await Promise.all([share, ruudStartsSharingFriend, ruudStartsSharingFriend2]);

			equalLocations(
				ruudSharedChannel.state.live_locations[ruud.id],
				ruudsLocation,
			);
			equalLocations(
				friendSharedChannel.state.live_locations[ruud.id],
				ruudsLocation,
			);
			equalLocations(
				friend2SharedChannel.state.live_locations[ruud.id],
				ruudsLocation,
			);
		});

		it('Ruud updates his location', async () => {
			let ruudsLocation = { lon: 90, lat: 90, accuracy: 9 };
			let update = ruudClient.updateLiveLocation(ruudsLocation);

			// All channels should be updated
			let ruudSharedChannelUpdated = eventPromise(
				ruudSharedChannel,
				'location.updated',
			);
			let friendSharedChannelUpdated = eventPromise(
				friendSharedChannel,
				'location.updated',
			);
			let friend2SharedChannelUpdated = eventPromise(
				friend2SharedChannel,
				'location.updated',
			);

			let ruudChannelWithFriendUpdated = eventPromise(
				ruudChannelWithFriend,
				'location.updated',
			);
			let friendChannelWithRuudUpdated = eventPromise(
				friendChannelWithRuud,
				'location.updated',
			);

			let ruudChannelWithFriend2Updated = eventPromise(
				ruudChannelWithFriend2,
				'location.updated',
			);
			let friend2ChannelWithRuudUpdated = eventPromise(
				friend2ChannelWithRuud,
				'location.updated',
			);

			await Promise.all([
				update,
				ruudSharedChannelUpdated,
				friendSharedChannelUpdated,
				friend2SharedChannelUpdated,
				ruudChannelWithFriendUpdated,
				friendChannelWithRuudUpdated,
				ruudChannelWithFriend2Updated,
				friend2ChannelWithRuudUpdated,
			]);
		});

		it('Ruud stops sharing with friend 1', async () => {
			let update = ruudChannelWithFriend.stopLiveLocation();
			let ruudChannelWithFriendUpdated = eventPromise(
				ruudChannelWithFriend,
				'location.sharing_stopped',
			);
			let friendChannelWithRuudUpdated = eventPromise(
				friendChannelWithRuud,
				'location.sharing_stopped',
			);
			await Promise.all([
				update,
				ruudChannelWithFriendUpdated,
				friendChannelWithRuudUpdated,
			]);
		});

		it('Ruud shares a location with friend that instantly expires', async () => {
			let ruudsLocation = { lon: 35, lat: 35, accuracy: 3.5 };
			let share = ruudChannelWithFriend.shareLiveLocation(ruudsLocation, 0);
			let ruudChannelWithFriendUpdated = eventPromise(
				ruudChannelWithFriend,
				'location.sharing_started',
			);
			let friendChannelWithRuudUpdated = eventPromise(
				friendChannelWithRuud,
				'location.sharing_started',
			);
			await Promise.all([
				share,
				ruudChannelWithFriendUpdated,
				friendChannelWithRuudUpdated,
			]);
			equalLocations(
				ruudChannelWithFriend.state.live_locations[ruud.id],
				ruudsLocation,
			);
			equalLocations(
				friendChannelWithRuud.state.live_locations[ruud.id],
				ruudsLocation,
			);

			// Update location should detect the channel access is expired
			let update = ruudClient.updateLiveLocation(ruudsLocation);
			let ruudsState = ruudChannelWithFriend.watch();
			let friendState = friendChannelWithRuud.watch();
			let out = await Promise.all([update, ruudsState, friendState]);
			expect(out[1].live_locations).to.be.null;
			expect(out[2].live_locations).to.be.null;
		});

		it('Ruud decides to share a map with a static location and share his live location in a message with friend2', async () => {
			let static_pointers = [{ lon: 50.0, lat: 51.0, accuracy: 20 }];
			let live_locations = [ruud.id];
			let location_map = { static_pointers, live_locations };
			let msg = {
				text: "Hey I'm going to the mall, and I'm currently here",
				attachments: [{ location_map }],
			};

			let send = ruudChannelWithFriend2.sendMessage(msg);
			let receivedMessage = eventPromise(friend2ChannelWithRuud, 'message.new');
			let out = await Promise.all([send, receivedMessage]);

			let friend2State = await friend2ChannelWithRuud.watch();
			expect(friend2State.live_locations).to.not.be.null;
			expect(friend2State.live_locations[out[0].message.user.id]).to.not.be
				.undefined;
		});
	});
});
