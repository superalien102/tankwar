import Tank from '@game/models/Tank';
import type Game from '@game/scenes/Game';
import {THREE} from 'enable3d';
import {LineGeometry} from 'three/examples/jsm/lines/LineGeometry';
import {LineMaterial} from 'three/examples/jsm/lines/LineMaterial';
import {Line2} from 'three/examples/jsm/lines/Line2';
import Explosion from '@game/models/Explosion';

class ShootHelper extends Line2 {
	constructor(private readonly tank: Tank) {
		const material = new LineMaterial({
			color: 0xff0000,
			linewidth: 0.05,
			transparent: true,
			opacity: 0.4,
			worldUnits: true,
		});

		super(new LineGeometry(), material);
		this.position.z = 0.3;
		this.rotateY(-Math.PI / 2);
	}

	public update() {
		const force = this.tank.getCanonDirection().multiplyScalar(10000);
		const speed = new THREE.Vector2(Math.hypot(force.x, force.z), force.y);
		const bulletWeight = 100;
		const gravity = 9.8;
		const tMax = 5;

		const nbSteps = 50;

		const points = Array.from({length: nbSteps}, (_, i) => {
			const t = i * (tMax / nbSteps);
			const x = t * speed.x;
			const y = (t * speed.y) - (0.5 * (gravity * bulletWeight) * t * t);
			return [x / 500, y / 500, 0];
		}).flat();
		this.geometry.setPositions(points);
		this.computeLineDistances();
	}
}

export default class TankPlayer extends Tank {
	public camera: THREE.PerspectiveCamera;
	private readonly shootHelper = new ShootHelper(this);
	public constructor(game: Game, position: THREE.Vector3, uuid?: string) {
		super(game, position, uuid);
		this.headlights.forEach(light => {
			light.castShadow = true;
		});
		this.canon.add(this.shootHelper);

		this.properties.getProperty('canonAngle').onChange(() => {
			this.shootHelper.update();
		}, true);

		this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
		this.camera.position.set(0, 0, 0);
		this.camera.rotateY(Math.PI);
		this.turret.add(this.camera);
	}

	update(delta: number) {
		super.update(delta);
	}

	shoot() {
		const hadShoot = super.shoot();
		if (hadShoot) {
			this.game.events.send('tank:shoot', this.uuid);
		}

		return hadShoot;
	}

	honk() {
		super.honk();
		this.game.events.send('tank:honk', this.uuid);
	}

	protected initPhysics() {
		this.game.physics.add.existing(this.chassis, {shape: 'convexMesh', mass: 1500, collisionGroup: 1});
		this.game.physics.add.existing(this.turret, {shape: 'convexMesh', mass: 200, collisionGroup: 1});
		this.game.physics.add.existing(this.canon, {shape: 'convexMesh', mass: 50, collisionGroup: 1});
	}

	protected createBullet(pos: THREE.Vector3, dir: THREE.Vector3) {
		const bullet = super.createBullet(pos, dir);
		// Event when bullet hit something
		bullet.onCollision(() => {
			const position = bullet.getWorldPosition(new THREE.Vector3());
			this.game.events.send('explosion:create', {
				position: position.toArray(),
				scale: 5,
			}, false);
			Explosion.make(this.game, position, 5, tank => {
				if (tank !== this) {
					this.game.events.send('tank:hit', {
						position: position.toArray(),
						from: this.uuid,
						to: tank.uuid,
						damage: 10,
					});
				}
			});
		});
		return bullet;
	}
}
