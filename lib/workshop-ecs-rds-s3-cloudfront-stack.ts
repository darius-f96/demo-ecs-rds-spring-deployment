import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from "aws-cdk-lib/aws-rds";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { CaCertificate } from "aws-cdk-lib/aws-rds";

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

    const dbEngine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_15_10,
    });
    const clusterParameters: { [key: string]: string } = {
      lc_monetary: "en_US.UTF-8",
      lc_numeric: "en_US.UTF-8",
      lc_time: "en_US.UTF-8",
      log_min_messages: "log",
      log_min_error_statement: "log",
      log_connections: "1",
      log_disconnections: "1",
      "rds.log_retention_period": "10080",
    };
    clusterParameters["rds.force_ssl"] = "1";
    const instanceParameters: { [key: string]: string } = {
      log_rotation_age: "1440",
      client_min_messages: "warning",
      log_filename: "postgresql.log.%Y-%m-%d",
      lc_messages: "en_US.UTF-8",
    };

    const customInstanceParameterGroup = new rds.ParameterGroup(
        this,
        "Internship2025InstanceParameterGroup",
        {
          engine: dbEngine,
          parameters: instanceParameters,
          description: "Custom parameter group based on Cloud City Building Blocks requirements",
        },
    );
    const auroraCluster = new rds.DatabaseCluster(this, 'AuroraPg', {
      engine: dbEngine,
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      defaultDatabaseName: 'springdb',
      credentials: rds.Credentials.fromGeneratedSecret('springuser'),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      parameters: clusterParameters,
      port: 5432,
      copyTagsToSnapshot:true,
      writer: rds.ClusterInstance.serverlessV2("ClusterWriterInstance", {
        enablePerformanceInsights: false,
        autoMinorVersionUpgrade: true,
        parameterGroup: customInstanceParameterGroup,
        caCertificate: CaCertificate.RDS_CA_RSA2048_G1,
        instanceIdentifier: `Internship2025-instance1`,
      }),
      readers:[
        rds.ClusterInstance.serverlessV2("ClusterReaderInstance1", {
          enablePerformanceInsights: false,
          autoMinorVersionUpgrade: true,
          parameterGroup: customInstanceParameterGroup,
          caCertificate: CaCertificate.RDS_CA_RSA2048_G1,
          instanceIdentifier: `Internship2025-instance2`,
        })
      ]
    });
    cdk.Tags.of(auroraCluster).add("Internship_2025", "");

    // allow ECS to connect to DB
    dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432));
    auroraCluster.connections.addSecurityGroup(dbSecurityGroup);

    const cluster = new ecs.Cluster(this, 'SpringCluster', { vpc });
    cdk.Tags.of(cluster).add("Internship_2025", "");
    const ecsExecutionRole = new iam.Role(this, 'EcsExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // This policy allows ECS agent to pull from ECR and write logs
    ecsExecutionRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );
    cdk.Tags.of(ecsExecutionRole).add("Internship_2025", "");
    const ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    cdk.Tags.of(ecsTaskRole).add("Internship_2025", "");
    // Secret for DB
    const dbSecret = auroraCluster.secret!;
    dbSecret.grantRead(ecsTaskRole);

    const springTaskDef = new ecs.FargateTaskDefinition(this, 'SpringTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: ecsExecutionRole,
      taskRole: ecsTaskRole,
    });
    cdk.Tags.of(springTaskDef).add("Internship_2025", "");

    const repo = ecr.Repository.fromRepositoryName(this, 'internship2025', "internship2025");

    const springContainer = springTaskDef.addContainer('SpringApp', {
      image: ecs.ContainerImage.fromEcrRepository(repo, "springapp"),
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
      executionRole: ecsExecutionRole,
      taskRole: ecsTaskRole,
    });

    liquibaseTaskDef.addContainer('Liquibase', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'liquibase'),
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
      code: lambda.Code.fromAsset(path.join(__dirname, './lambda/')), // compiled Go binary folder
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'bootstrap',
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
