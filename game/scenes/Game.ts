import {GUI} from 'lil-gui';
import Stats from 'stats.js';
import {THREE} from 'enable3d';
import {ChunkLoader} from '@game/world/ChunkLoader';
import {World} from '@game/world/World';
import {ChunkPopulator} from '@game/world/ChunkPopulator';
import {Sun} from '@game/utils/Sun';
import PlayerController from '@game/utils/PlayerController';
import Tank from '@game/models/Tank';
import TankNetwork from '@game/models/TankNetwork';
import GameEvent from '@game/event/GameEvent';
import TankPlayer from '@game/models/TankPlayer';
import Explosion from '@game/models/Explosion';
import ResizeableScene3D from '@game/scenes/ResizeableScene3D';
import {type Metadata, type NetworkEvents} from '@game/network/NetworkEvents';
import {type Network} from '@game/network/Network';
import AudioManager from '@game/utils/AudioManager';
import Emittery from 'emittery';
import {pointLightBuffer} from '@game/utils/LightBuffer';

export type GameConfig = {
	network: Network<NetworkEvents, Metadata>;
};

// eslint-disable-next-line @typescript-eslint/naming-convention
const DEBUG = false;

class TankManager extends Map<string, Tank> {
	public readonly events = new Emittery<{
		add: Tank;
		remove: Tank[];
	}>();

	private readonly networkTanks = new Map<string, TankNetwork>();

	public set(uuid: string, tank: Tank) {
		if (this.has(uuid)) {
			return this;
		}

		if (tank instanceof TankNetwork) {
			this.networkTanks.set(tank.uuid, tank);
		}

		void this.events.emit('add', tank);
		return super.set(uuid, tank);
	}

	public add(tank: Tank) {
		return this.set(tank.uuid, tank);
	}

	public remove(tank: Tank) {
		return this.delete(tank.uuid);
	}

	public delete(uuid: string) {
		this.networkTanks.delete(uuid);
		const tank = this.get(uuid);
		if (tank) {
			tank.destroy();
			void this.events.emit('remove', [tank]);
		}

		return super.delete(uuid);
	}

	public clear() {
		void this.events.emit('remove', this.array);
		this.networkTanks.clear();
		super.clear();
	}

	public getNetwork(uuid: string) {
		return this.networkTanks.get(uuid);
	}

	public getNetworks(): TankNetwork[] {
		return [...this.networkTanks.values()];
	}

	public get array() {
		return [...this.values()];
	}
}

export default class Game extends ResizeableScene3D {
	public readonly events = new GameEvent();
	public readonly audioManager = new AudioManager();

	public player!: TankPlayer;
	public world!: World;

	public readonly tanks = new TankManager();
	private readonly stats = new Stats();

	private readonly config: GameConfig;
	private sun!: Sun;
	private readonly playerController = new PlayerController(this);

	constructor(config: GameConfig) {
		super({key: 'GameScene'});
		this.stats.dom.style.cssText = 'position: absolute; bottom: 0; right: 0; z-index: 1000;';
		this.config = config;
		this.events.setNetwork(config.network);
	}

	async preload() {
		await this.load.preload('tree', '/glb/tree.glb');
		await this.load.preload('rock', '/glb/rock.glb');
		await Tank.loadModel(this.load, '/glb/tank.glb');
		await Explosion.loadModel(this.load, '/glb/fireball.glb');
	}

	init() {
		super.init();
		this.playerController.init();
	}

	public async respawn() {
		const position = await this.world.getSpawnPosition();
		position.y += 1;

		if (this.player) {
			this.tanks.remove(this.player);
		}

		this.player = new TankPlayer(this, position);
		const data = this.config.network.getMetadata();
		this.player.import({
			pseudo: data?.name,
			type: data?.tank,
		});
		this.player.addToScene();
		this.tanks.add(this.player);

		this.playerController.setTank(this.player);
	}

	async create() {
		this.audioManager.setCamera(this.camera);
		pointLightBuffer.init(this);
		this.sun = new Sun(this);
		this.scene.add(this.sun);
		// Fog
		const fogColor = new THREE.Color('#63a7ff');
		this.scene.fog = new THREE.Fog(fogColor, 50, 150);
		this.scene.background = new THREE.Color(fogColor);

		const chunkLoader = new ChunkLoader({
			worldHeightMapUrl: '/images/heightmap.webp',
			chunkSize: 128,
			scale: 0.25,
		});

		const treeModel = (await this.load.gltf('tree')).scenes[0];
		treeModel.traverse(child => {
			if (child instanceof THREE.Mesh) {
				child.receiveShadow = true;
				child.castShadow = true;
			}
		});
		treeModel.scale.set(0.5, 0.5, 0.5);

		const rockModel = (await this.load.gltf('rock')).scenes[0];
		rockModel.traverse(child => {
			if (child instanceof THREE.Mesh) {
				child.receiveShadow = true;
				child.castShadow = true;
			}
		});
		rockModel.scale.set(0.5, 0.5, 0.5);

		const chunkPopulator = new ChunkPopulator()
			.addElement(treeModel)
			.addElement(rockModel);

		this.world = new World(this, chunkLoader, chunkPopulator);

		await this.respawn();

		const position = this.player.position.clone();
		for (let i = 0; i < 0; i++) {
			position.y += 1;
			const tank = new Tank(this, position);
			tank.addToScene();
			this.tanks.add(tank);
		}

		if (DEBUG) {
			// GUI
			const panel = new GUI();
			const params = {
				debug: false,
				mode: 2049,
			};

			panel.add(params, 'debug').onChange((value: boolean) => {
				if (value) {
					this.physics.debug?.enable();
				} else {
					this.physics.debug?.disable();
				}
			});
			panel
				.add(params, 'mode', [1 + 2048, 1 + 4096, 1 + 2048 + 4096])
				.onChange((value: number) => {
					this.physics.debug?.mode(value);
				});

			// Stats
			this.renderer.domElement.parentElement?.appendChild(this.stats.dom);
		}

		this.events.on('tank:shoot', uuid => {
			this.tanks.getNetwork(uuid)?.shoot();
		});

		this.events.on('tank:honk', uuid => {
			this.tanks.getNetwork(uuid)?.honk();
		});

		this.events.on('tank:hit', ({damage, to}) => {
			this.tanks.get(to)?.hit(damage);
		});

		this.events.on('explosion:create', ({position, scale}) => {
			Explosion.make(this, new THREE.Vector3().fromArray(position), scale);
		});

		this.events.on('sync:time', time => {
			this.sun.angle = time;
		});

		const tanks = new Map<string, any>();
		this.config.network.channel('update').on((data: any) => {
			if (!this.player || data.uuid === this.player.uuid) {
				return;
			}

			tanks.set(data.uuid, data);
		});

		asyncLoop(async () => {
			await this.world.update();
			if (this.config.network.isHost) {
				this.events.send('sync:time', this.sun.angle, false);
			}
		}, 300);
		asyncLoop(async () => {
			this.config.network.channel('update').send(this.player.export());
			tanks.forEach((data, uuid) => {
				const tank = this.tanks.getNetwork(uuid);
				if (tank) {
					tank.networkUpdate(data);
				} else {
					const position = new THREE.Vector3().fromArray(data.position);
					const tank = new TankNetwork(this, position, data.uuid);
					this.tanks.add(tank);
					tank.addToScene();
					tank.networkUpdate(data);
				}
			});
			tanks.clear();
		}, 100);
	}

	update(_time: number, delta: number) {
		this.stats.begin();
		this.sun.update();
		this.playerController.update();

		this.tanks.forEach(entity => {
			entity.update(delta);
			if (entity instanceof TankNetwork && entity.getLastUpdate() + (5000 + delta) < Date.now()) {
				this.tanks.remove(entity);
			}
		});

		this.stats.end();
	}
}

function asyncLoop(callback: () => Promise<void>, minInterval: number) {
	const loop = async () => {
		const start = Date.now();
		await callback();
		const end = Date.now();
		const interval = Math.max(minInterval - (end - start), 0);
		setTimeout(loop, interval);
	};

	void loop();
}
