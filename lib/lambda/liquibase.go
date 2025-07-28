package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/ecs"
)

func handler(ctx context.Context) (string, error) {

	sess := session.Must(session.NewSession())
	svc := ecs.New(sess)

	cluster := os.Getenv("CLUSTER_NAME")
	taskDef := os.Getenv("TASK_DEF")
	subnets := strings.Split(os.Getenv("SUBNETS"), ",")

	fmt.Printf("Running Liquibase task in cluster %s...\n", cluster)

	_, err := svc.RunTask(&ecs.RunTaskInput{
		Cluster:        aws.String(cluster),
		TaskDefinition: aws.String(taskDef),
		LaunchType:     aws.String("FARGATE"),
		Count:          aws.Int64(1),
		NetworkConfiguration: &ecs.NetworkConfiguration{
			AwsvpcConfiguration: &ecs.AwsVpcConfiguration{
				Subnets:       aws.StringSlice(subnets),
				AssignPublicIp: aws.String("DISABLED"),
			},
		},
	})

	if err != nil {
		return "", fmt.Errorf("failed to run Liquibase task: %v", err)
	}

	return "Liquibase task triggered successfully!", nil
}

func main() {
	lambda.Start(handler)
}
