import type Tank from '@game/models/Tank';
import {THREE} from 'enable3d';
import {Keyboard} from '@game/utils/Keyboard';
import {AdvancedThirdPersonControls} from '@game/utils/AdvancedThirdPersonControls';
import type Game from '@game/scenes/Game';
import type TankPlayer from '@game/models/TankPlayer';

export default class PlayerController {
	private readonly keyboard = new Keyboard(false)
		.addAction('turnRight', ['KeyD'])
		.addAction('turnLeft', ['KeyA'])
		.addAction('moveForward', ['KeyW'])
		.addAction('moveBackward', ['KeyS'])
		.addAction('shoot', ['Space'])
		.addAction('resetPosition', ['KeyR'])
		.addAction('headlights', ['KeyL'])
		.addAction('honk', ['KeyK']);

	private tank?: Tank;
	private control?: AdvancedThirdPersonControls;

	constructor(private readonly game: Game) {
	}

	public setTank(tank: TankPlayer) {
		this.tank = tank;
		this.control?.setTarget(tank.object3d);
	}

	public update() {
		if (!this.tank) {
			return;
		}

		this.control?.update();

		const steeringIncrement = 0.04;
		const steeringClamp = 0.5;
		const maxEngineForce = 6000;

		// Front/back
		if (this.keyboard.getAction('moveForward')) {
			this.tank.engineForce = maxEngineForce;
		} else if (this.keyboard.getAction('moveBackward')) {
			this.tank.engineForce = -maxEngineForce / 2;
		} else {
			this.tank.engineForce = 0;
		}

		if (this.keyboard.getAction('turnLeft')) {
			if (this.tank.steering < steeringClamp) {
				this.tank.steering += steeringIncrement;
			}
		} else if (this.keyboard.getAction('turnRight')) {
			if (this.tank.steering > -steeringClamp) {
				this.tank.steering -= steeringIncrement;
			}
		} else {
			if (this.tank.steering > 0) {
				this.tank.steering -= steeringIncrement / 2;
			}

			if (this.tank.steering < 0) {
				this.tank.steering += steeringIncrement / 2;
			}

			if (Math.abs(this.tank.steering) <= steeringIncrement) {
				this.tank.steering = 0;
			}
		}

		const rotation = this.game.camera.getWorldDirection(new THREE.Vector3());
		const rotation2 = this.tank.object3d.getWorldDirection(new THREE.Vector3());
		this.tank.turretAngle = -Math.atan2(rotation2.x, rotation2.z) + Math.atan2(rotation.x, rotation.z);
	}

	init() {
		this.control = new AdvancedThirdPersonControls(this.game.camera, this.game.renderer.domElement, {
			offset: new THREE.Vector3(0, 0.5, 0),
			targetRadius: 6,
			autoUpdate: false,
		});
		this.control.onPointerLockChange(isLocked => {
			this.keyboard.setEnabled(isLocked);
		});

		if (this.tank) {
			this.control.setTarget(this.tank.object3d);
		}

		this.keyboard.start();
		this.keyboard.on('wheel', (event: WheelEvent) => {
			if (this.tank) {
				this.tank.canonAngle += 0.005 * Math.sign(event.deltaY);
			}
		});
		this.keyboard.getOnAction('shoot', () => {
			this.tank?.shoot();
		});

		this.keyboard.getOnAction('resetPosition', () => {
			if (this.tank && !this.tank.isDead()) {
				void this.tank.resetPosition();
			} else {
				void this.game.respawn();
			}
		});

		this.keyboard.getOnAction('honk', () => {
			this.tank?.honk();
		}, 100);

		this.keyboard.getOnAction('headlights', () => {
			this.tank?.toggleHeadlights();
		}, 100);
	}
}
