import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from "aws-cdk-lib/aws-rds";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export class EcsSpringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'SpringVpc', {
      maxAzs: 2,
      natGateways: 1,
    });
    cdk.Tags.of(vpc).add("Internship_2025", "");
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc,
      allowAllOutbound: true,
    });

    const auroraCluster = new rds.DatabaseCluster(this, 'AuroraPg', {
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      defaultDatabaseName: 'springdb',
      credentials: rds.Credentials.fromGeneratedSecret('springuser'),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(auroraCluster).add("Internship_2025", "");

    // allow ECS to connect to DB
    dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432));
    auroraCluster.connections.addSecurityGroup(dbSecurityGroup);

    const cluster = new ecs.Cluster(this, 'SpringCluster', { vpc });
    cdk.Tags.of(cluster).add("Internship_2025", "");
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    ecsTaskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    cdk.Tags.of(ecsTaskRole).add("Internship_2025", "");

    // Secret for DB
    const dbSecret = auroraCluster.secret!;
    dbSecret.grantRead(ecsTaskRole);

    const springTaskDef = new ecs.FargateTaskDefinition(this, 'SpringTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: ecsTaskRole,
      taskRole: ecsTaskRole,
    });
    cdk.Tags.of(springTaskDef).add("Internship_2025", "");
    const springContainer = springTaskDef.addContainer('SpringApp', {
      image: ecs.ContainerImage.fromRegistry('your-dockerhub/spring-app:latest'),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'SpringApp' }),
      environment: {
        SPRING_DATASOURCE_URL: `jdbc:postgresql://${auroraCluster.clusterEndpoint.hostname}:5432/springdb`,
        SPRING_DATASOURCE_USERNAME: 'springuser',
      },
      secrets: {
        SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
    });

    springContainer.addPortMappings({ containerPort: 8080 });
    cdk.Tags.of(springContainer).add("Internship_2025", "");

    const liquibaseTaskDef = new ecs.FargateTaskDefinition(this, 'LiquibaseTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: ecsTaskRole,
      taskRole: ecsTaskRole,
    });

    liquibaseTaskDef.addContainer('Liquibase', {
      image: ecs.ContainerImage.fromRegistry('liquibase/liquibase:latest'),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'Liquibase' }),
      essential: true,
      command: [
        `--url=jdbc:postgresql://${auroraCluster.clusterEndpoint.hostname}:5432/springdb`,
        "--username=springuser",
        "--password=${SPRING_DATASOURCE_PASSWORD}",
        "--changeLogFile=db/db.changelog-master.xml",
        "update"
      ],
      secrets: {
        SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
    });
    cdk.Tags.of(liquibaseTaskDef).add("Internship_2025", "");

    const springService = new ecs.FargateService(this, 'SpringService', {
      cluster,
      taskDefinition: springTaskDef,
      desiredCount: 2,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    cdk.Tags.of(springService).add("Internship_2025", "");

    const liquibaseRunner = new lambda.Function(this, 'LiquibaseRunner', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/')), // compiled Go binary folder
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'main',
      environment: {
        CLUSTER_NAME: cluster.clusterName,
        TASK_DEF: liquibaseTaskDef.taskDefinitionArn,
        SUBNETS: vpc.privateSubnets.map(s => s.subnetId).join(","),
      },
    });

    // Allow Lambda to run ECS tasks
    liquibaseRunner.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: ['*'],
    }));
    liquibaseRunner.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [ecsTaskRole.roleArn],
    }));
    cdk.Tags.of(liquibaseRunner).add("Internship_2025", "");
    new cr.AwsCustomResource(this, 'LiquibaseRun', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: liquibaseRunner.functionName,
          InvocationType: 'RequestResponse'
        },
        physicalResourceId: cr.PhysicalResourceId.of('LiquibaseRunOnce'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [liquibaseRunner.functionArn],
        }),
      ]),
    });

    // (Optional) Ensure service starts AFTER Liquibase ran
    springService.node.addDependency(auroraCluster);
  }
}
