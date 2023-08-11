import {ExtendedGroup, ExtendedMesh, ExtendedObject3D, THREE} from 'enable3d';
import Entity from '@game/models/Entity';
import type * as Plugins from '@enable3d/three-graphics/jsm/plugins';
import Explosion from '@game/models/Explosion';
import shortUuid from 'short-uuid';
import {Properties} from '@game/utils/Properties';
import type Game from '@game/scenes/Game';
import {type TankType, TankTypes} from '@game/models/TankType';
import {type Audio} from '@game/utils/AudioManager';
import Random from '@game/utils/Random';
import {makeBullet} from '@game/models/Bullet';

export enum WheelPosition {
	FrontLeft = 0,
	FrontRight = 1,
	RearLeft = 2,
	RearRight = 3,
}

export type TankState = {
	pseudo: string;
	type: TankType;
	turretAngle: number;
	canonAngle: number;
	steering: number;
	engineForce: number;
	breakingForce: number;
	position: THREE.Vector3;
	rotation: THREE.Quaternion;
	headlights: boolean;
	health: number;
};

class Parts extends Map<string, ExtendedObject3D> {
	public clone(): Parts {
		const parts = new Parts();
		this.forEach((part, key) => {
			const p = part.clone();
			parts.set(key, p);
		});
		return parts;
	}
}

export default class Tank extends Entity {
	static async loadModel(loader: Plugins.Loaders, url: string) {
		const tankGlb = await loader.gltf(url);
		tankGlb.scene.children.forEach(child => {
			if (child instanceof THREE.Mesh) {
				const o = new ExtendedMesh(child.geometry, child.material);
				o.geometry.center();
				o.scale.set(child.scale.x, child.scale.y, child.scale.z);
				o.receiveShadow = true;
				o.castShadow = true;
				o.name = child.name;
				this.parts.set(child.name, o as unknown as ExtendedObject3D);
			}
		});

		this.materials = Object.fromEntries(
			Object.entries(TankTypes).map(([key, value]) => {
				const map = new THREE.TextureLoader().load(value.url);
				map.encoding = THREE.sRGBEncoding;
				map.flipY = false;
				map.repeat.set(1, 1);
				map.needsUpdate = true;
				return [key, new THREE.MeshStandardMaterial({map, metalness: 0.4, metalnessMap: map, roughness: 0.8})];
			}),
		) as Record<keyof typeof TankTypes, THREE.MeshStandardMaterial>;
	}

	private static readonly parts = new Parts();
	private static materials: Record<keyof typeof TankTypes, THREE.MeshStandardMaterial>;

	public readonly properties = new Properties<TankState>();
	protected readonly chassis: ExtendedObject3D;
	protected readonly turret: ExtendedObject3D;
	protected readonly canon: ExtendedObject3D;
	protected readonly headlights: THREE.SpotLight[] = [];

	private readonly vehicle: Ammo.btRaycastVehicle;
	private readonly wheelMeshes: ExtendedObject3D[] = [];
	private readonly group = new ExtendedGroup();
	private lastShot = 0;
	private canonMotor!: Ammo.btHingeConstraint;
	private turretMotor!: Ammo.btHingeConstraint;
	private readonly tuning: Ammo.btVehicleTuning;
	private readonly model = Tank.parts.clone();
	private readonly shootSound: Audio;
	private readonly honkSound: Audio;
	private readonly engineSound: Audio;

	constructor(game: Game, position: THREE.Vector3, uuid: string = shortUuid.uuid()) {
		super(game, uuid);
		this.group = new ExtendedGroup();

		this.shootSound = game.audioManager.createAudio('/sounds/shoot.ogg');
		this.honkSound = game.audioManager.createAudio('/sounds/honk.ogg');
		this.engineSound = game.audioManager.createAudio();

		this.chassis = new ExtendedObject3D().add(this.model.get('TankFree_Body')!);
		this.turret = new ExtendedObject3D().add(this.model.get('TankFree_Tower')!);
		this.canon = new ExtendedObject3D().add(this.model.get('TankFree_Canon')!);

		this.group.add(this.chassis, this.turret, this.canon);

		this.chassis.position.copy(position);
		this.chassis.rotation.set(0, Math.PI, 0);
		this.canon.position.copy(position);
		this.canon.rotation.set(0, Math.PI, 0);
		this.turret.position.copy(position);
		this.turret.rotation.set(0, Math.PI, 0);

		this.chassis.add(this.shootSound, this.honkSound, this.engineSound);

		this.engineSound.setLoop(true);

		// Add lights to chassis
		const headlightA = new THREE.SpotLight(0xfff0c7, 5, 50, Math.PI / 5, 0.5);
		const headlightB = headlightA.clone();
		headlightA.position.set(0.5, 0.15, 0.5);
		headlightA.target.position.copy(headlightA.position).add(new THREE.Vector3(0, -0.5, 2));
		headlightB.position.set(-0.5, 0.15, 0.5);
		headlightB.target.position.copy(headlightB.position).add(new THREE.Vector3(0, -0.5, 2));
		this.chassis.add(headlightA, headlightA.target, headlightB, headlightB.target);
		this.headlights.push(headlightA, headlightB);

		this.initPhysics();

		this.wheelMeshes = [
			this.model.get('TankFree_Wheel_f_right')!,
			this.model.get('TankFree_Wheel_f_left')!,
			this.model.get('TankFree_Wheel_b_left')!,
			this.model.get('TankFree_Wheel_b_right')!,
		];

		this.tuning = new Ammo.btVehicleTuning();
		const rayCaster = new Ammo.btDefaultVehicleRaycaster(
			this.game.physics.physicsWorld,
		);
		this.vehicle = new Ammo.btRaycastVehicle(
			this.tuning,
			this.chassis.body.ammo,
			rayCaster,
		);

		this.vehicle.setCoordinateSystem(0, 1, 2);
		this.game.physics.physicsWorld.addAction(this.vehicle);

		this.init();

		const wheelAxisPositionBack = -0.4;
		const wheelRadiusBack = 0.25;
		const wheelHalfTrackBack = 0.55;
		const wheelAxisHeightBack = -0.3;

		const wheelAxisFrontPosition = 0.4;
		const wheelRadiusFront = 0.25;
		const wheelHalfTrackFront = 0.55;
		const wheelAxisHeightFront = -0.3;

		this.addWheel(
			true,
			new Ammo.btVector3(
				wheelHalfTrackFront,
				wheelAxisHeightFront,
				wheelAxisFrontPosition,
			),
			wheelRadiusFront,
			WheelPosition.FrontLeft,
		);
		this.addWheel(
			true,
			new Ammo.btVector3(
				-wheelHalfTrackFront,
				wheelAxisHeightFront,
				wheelAxisFrontPosition,
			),
			wheelRadiusFront,
			WheelPosition.FrontRight,
		);
		this.addWheel(
			false,
			new Ammo.btVector3(
				-wheelHalfTrackBack,
				wheelAxisHeightBack,
				wheelAxisPositionBack,
			),
			wheelRadiusBack,
			WheelPosition.RearLeft,
		);
		this.addWheel(
			false,
			new Ammo.btVector3(
				wheelHalfTrackBack,
				wheelAxisHeightBack,
				wheelAxisPositionBack,
			),
			wheelRadiusBack,
			WheelPosition.RearRight,
		);

		this.properties
			.addProperty('headlights', {
				default: true,
				onChange: (value: boolean) => {
					this.headlights.forEach(light => {
						light.intensity = value ? 5 : 0;
					});
				},
			})
			.addProperty('type', {
				default: 'heig',
				onChange: value => {
					this.setTexture(value);
				},
			})
			.addProperty('turretAngle', {
				default: 0,
				onChange: value => {
					this.turretMotor.setLimit(value, value, 0.9, 1);
				},
			})
			.addProperty('canonAngle', {
				default: 0,
				onChange: value => {
					this.canonMotor.setLimit(value, value, 0.9, 1);
				},
			})
			.addProperty('pseudo', {
				default: 'Player',
			})
			.addProperty('engineForce', {
				default: 0,
			})
			.addProperty('breakingForce', {
				default: 0,
			})
			.addProperty('steering', {
				default: 0,
			})
			.addProperty('position', {
				default: this.chassis.position,
				get: () => this.chassis.position,
				export: data => data.toArray(),
				import: data => new THREE.Vector3().fromArray(data),
			})
			.addProperty('rotation', {
				default: this.chassis.quaternion,
				get: () => this.chassis.quaternion,
				export: data => data.toArray(),
				import: data => new THREE.Quaternion().fromArray(data),
			})
			.addProperty('health', {
				default: 100,
				set: value => Math.min(Math.max(value, 0), 100),
				onChange: (health, oldHealth) => {
					if (health <= 0 && oldHealth > 0) {
						this.die();
					}
				},
			});
	}

	public get object3d(): THREE.Object3D {
		return this.chassis;
	}

	public onChange(listener: () => void) {
		return this.properties.on('change', listener);
	}

	public get turretAngle() {
		return this.turretMotor.getHingeAngle();
	}

	public set turretAngle(angle: number) {
		this.properties.getProperty('turretAngle').value = angle;
	}

	public get canonAngle() {
		return this.canonMotor.getHingeAngle();
	}

	public set canonAngle(angle: number) {
		// Limit the canon angle to -45° and 45°
		angle = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, angle));
		this.properties.getProperty('canonAngle').value = angle;
	}

	public get pseudo() {
		return this.properties.getProperty('pseudo').value;
	}

	public set pseudo(pseudo: string) {
		this.properties.getProperty('pseudo').value = pseudo;
	}

	public get engineForce() {
		return this.properties.getProperty('engineForce').value;
	}

	public set engineForce(force: number) {
		this.properties.getProperty('engineForce').value = force;
	}

	public get breakingForce() {
		return this.properties.getProperty('breakingForce').value;
	}

	public set breakingForce(force: number) {
		this.properties.getProperty('breakingForce').value = force;
	}

	public get steering() {
		return this.properties.getProperty('steering').value;
	}

	public set steering(value: number) {
		this.properties.getProperty('steering').value = value;
	}

	public get speed() {
		return this.vehicle.getCurrentSpeedKmHour();
	}

	public get health() {
		return this.properties.getProperty('health').value;
	}

	public set health(value: number) {
		this.properties.getProperty('health').value = value;
	}

	public get position() {
		return this.properties.getProperty('position').value;
	}

	public get type() {
		return TankTypes[this.properties.getProperty('type').value];
	}

	public isDead() {
		return this.health <= 0;
	}

	public die() {
		const random = new Random();
		this.chassis.body.applyForce(
			random.number(-15000, 15000),
			random.number(10000, 15000),
			random.number(-15000, 15000),
		);
		this.chassis.body.applyTorque(
			random.number(-10000, 10000),
			random.number(-10000, 10000),
			random.number(-10000, 10000),
		);
		this.game.physics.physicsWorld.removeConstraint(this.turretMotor);
		this.game.physics.physicsWorld.removeConstraint(this.canonMotor);
		this.vehicle.applyEngineForce(0, WheelPosition.FrontLeft);
		this.vehicle.applyEngineForce(0, WheelPosition.FrontRight);
	}

	public hit(damage: number) {
		this.properties.getProperty('health').value -= damage;
	}

	public shoot() {
		if (this.lastShot + 750 > Date.now() || this.isDead()) {
			return false;
		}

		this.shootSound.play();
		this.lastShot = Date.now();
		// Get canon position
		const pos = this.canon.getWorldPosition(new THREE.Vector3());
		// Translate the position to the front of the canon
		pos.add(
			this.canon.getWorldDirection(new THREE.Vector3()).multiplyScalar(0.6),
		);

		Explosion.make(this.game, pos);

		this.createBullet(pos, this.getCanonDirection());

		return true;
	}

	public toggleHeadlights() {
		this.properties.getProperty('headlights').set(value => !value);
	}

	public honk() {
		this.honkSound.play(
			this.type.honk,
		);
	}

	public getCanonDirection() {
		return this.canon.getWorldDirection(new THREE.Vector3());
	}

	public update(delta: number) {
		super.update(delta);
		const n = this.vehicle.getNumWheels();
		for (let i = 0; i < n; i++) {
			this.vehicle.updateWheelTransform(i, true);
			const tm = this.vehicle.getWheelTransformWS(i);
			const p = tm.getOrigin();
			const q = tm.getRotation();
			this.wheelMeshes[i].position.set(p.x(), p.y(), p.z());
			this.wheelMeshes[i].quaternion.set(q.x(), q.y(), q.z(), q.w());
		}

		const {engineForce, breakingForce, steering, speed} = this;
		if (!this.isDead()) {
			this.vehicle.setSteeringValue(
				steering,
				WheelPosition.FrontLeft,
			);
			this.vehicle.setSteeringValue(
				steering,
				WheelPosition.FrontRight,
			);

			this.engineSound.setVolume(
				Math.max(0, (Math.abs(speed) + 30) / 100),
			);
			// Set pitch
			this.engineSound.setPlaybackRate(
				Math.max(0.5, (Math.abs(speed) + 30) / 50),
			);

			this.vehicle.applyEngineForce(engineForce - (speed * 75), WheelPosition.FrontLeft);
			this.vehicle.applyEngineForce(engineForce - (speed * 75), WheelPosition.FrontRight);

			this.vehicle.setBrake(breakingForce / 2, WheelPosition.FrontLeft);
			this.vehicle.setBrake(breakingForce / 2, WheelPosition.FrontRight);
			this.vehicle.setBrake(breakingForce, WheelPosition.RearLeft);
			this.vehicle.setBrake(breakingForce, WheelPosition.RearRight);
		}

		this.vehicle.applyEngineForce(-(speed) * 75, WheelPosition.RearLeft);
		this.vehicle.applyEngineForce(-(speed) * 75, WheelPosition.RearRight);
	}

	public addToScene() {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		this.game.add.existing(this.group);
		this.engineSound.play('/sounds/engine-loop2.ogg');
	}

	public removeFromScene() {
		this.group.removeFromParent();
	}

	public async resetPosition() {
		const position = await this.game.world.getPositionAt(this.object3d.position);
		position.y += 1;
		void this.teleport(position);
	}

	public destroy(): void {
		this.game.physics.physicsWorld.removeAction(this.vehicle);
		this.game.physics.physicsWorld.removeConstraint(this.turretMotor);
		this.game.physics.physicsWorld.removeConstraint(this.canonMotor);
		this.game.physics.destroy(this.chassis);
		this.game.physics.destroy(this.turret);
		this.game.physics.destroy(this.canon);
		this.group.traverse(child => {
			if (child instanceof THREE.Mesh) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call
				child.geometry?.dispose();
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call
				child.material?.dispose();
			}
		});
		this.group.clear();
		this.group.removeFromParent();
	}

	public export(): TankState & {uuid: string} {
		return {
			uuid: this.uuid,
			...this.properties.export(),
		};
	}

	public import(state: Partial<TankState>): void {
		this.properties.import(state);
	}

	public setTexture(type: TankType) {
		const material = Tank.materials[type];
		this.model.forEach(mesh => {
			mesh.material = material;
		});
	}

	public getDistanceTo(tank: Tank): {distance: number; direction: number} {
		const distance = this.position.distanceTo(tank.position);

		const turretAngle = this.turret.getWorldDirection(new THREE.Vector3());
		const direction = Math.atan2(turretAngle.x, turretAngle.z)
			- Math.atan2(tank.position.x - this.position.x, tank.position.z - this.position.z);

		return {distance, direction};
	}

	protected init() {
		this.turretMotor = this.game.physics.add.constraints.hinge(
			this.chassis.body,
			this.turret.body,
			{
				pivotA: {y: 0.3},
				pivotB: {y: -0.22},
				axisA: {y: 1},
				axisB: {y: 1},
			},
		);

		// Attach the canon to the tower
		this.canonMotor = this.game.physics.add.constraints.hinge(
			this.turret.body,
			this.canon.body,
			{
				pivotA: {y: -0.05, z: 0.4},
				pivotB: {y: 0, z: -0.3},
				axisA: {x: 1},
				axisB: {x: 1},
			},
		);

		// Set the limits of the canon
		this.canonMotor.setLimit(-Math.PI / 4, Math.PI / 4, 0.9, 0.3);
	}

	protected async updatePhysics() {
		const physics = [
			this.chassis.body,
		];

		physics.forEach(body => {
			body.needUpdate = true;
		});

		await Promise.all(physics.map(async body => new Promise(resolve => {
			body.once.update(resolve);
		})));
	}

	protected setCollisionFlags(flags: number) {
		this.chassis.body.setCollisionFlags(flags);
	}

	protected async teleport(position: THREE.Vector3) {
		const offset = this.object3d.position.clone().sub(position);
		this.setCollisionFlags(2);
		this.object3d.position.sub(offset);
		const direction = this.object3d.getWorldDirection(new THREE.Vector3());
		this.object3d.rotation.set(0, Math.atan2(direction.x, direction.z), 0);

		await this.updatePhysics();
		this.setCollisionFlags(0);
		this.setVelocity(new THREE.Vector3());
		this.setAngularVelocity(new THREE.Vector3());
	}

	protected createBullet(pos: THREE.Vector3, direction: THREE.Vector3) {
		const bullet = makeBullet(this.game, pos);
		const force = direction.clone().multiplyScalar(10000);
		const recoil = force.clone().multiplyScalar(-0.2);
		this.canon.body.applyForce(recoil.x, recoil.y, recoil.z);
		bullet.body.applyForce(force.x, force.y, force.z);
		return bullet;
	}

	protected initPhysics() {
		this.game.physics.add.existing(this.chassis, {mass: 1500, collisionGroup: 1, shape: 'box', width: 0.8, height: 0.5, depth: 1.1, y: 0.01});
		this.game.physics.add.existing(this.turret, {mass: 200, collisionGroup: 1, shape: 'box', width: 0.5, height: 0.3, depth: 0.5});
		this.game.physics.add.existing(this.canon, {mass: 50, collisionGroup: 1, shape: 'box', width: 0.1, height: 0.1, depth: 0.7});
	}

	private setVelocity(velocity: THREE.Vector3) {
		[
			this.chassis.body,
			this.turret.body,
			this.canon.body,
		].forEach(body => {
			body.setVelocity(velocity.x, velocity.y, velocity.z);
		});
	}

	private setAngularVelocity(velocity: THREE.Vector3) {
		[
			this.chassis.body,
			this.turret.body,
			this.canon.body,
		].forEach(body => {
			body.setAngularVelocity(velocity.x, velocity.y, velocity.z);
		});
	}

	private addWheel(
		isFront: boolean,
		pos: Ammo.btVector3,
		radius: number,
		index: number,
	) {
		const suspensionStiffness = 60.0;
		const suspensionDamping = 6;
		const suspensionCompression = 10;
		const suspensionRestLength = 0.01;

		const friction = 100;
		const rollInfluence = 0.1;

		const wheelDirection = new Ammo.btVector3(0, -1, 0);
		const wheelAxle = new Ammo.btVector3(-1, 0, 0);
		const wheelInfo = this.vehicle.addWheel(
			pos,
			wheelDirection,
			wheelAxle,
			suspensionRestLength,
			radius,
			this.tuning,
			isFront,
		);

		wheelInfo.set_m_suspensionStiffness(suspensionStiffness);
		wheelInfo.set_m_wheelsDampingRelaxation(suspensionDamping);
		wheelInfo.set_m_wheelsDampingCompression(suspensionCompression);
		wheelInfo.set_m_maxSuspensionForce(10000);

		wheelInfo.set_m_frictionSlip(friction);
		wheelInfo.set_m_rollInfluence(rollInfluence);

		this.group.add(this.wheelMeshes[index]);
	}
}
