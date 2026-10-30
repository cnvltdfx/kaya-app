// Report generator: invoked by EventBridge Scheduler with { reports: [{ type, days }] }.
// The sales data still lives inside the API server (backend/src/lib/db.js), so this asks an
// in-service instance to build each report on its private report port; the app writes the
// files to the reports bucket. Once the data moves to Aurora, query it here instead.
// Env: ASG_NAME, REPORTS_PORT.
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

const autoscaling = new AutoScalingClient({});
const ec2 = new EC2Client({});

// Each instance keeps its own data until the move to Aurora, so with several running, the
// reports reflect only the one picked here (the deploy README says to run one).
async function apiServer() {
  const { AutoScalingGroups = [] } = await autoscaling.send(new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [process.env.ASG_NAME] }));
  const ids = (AutoScalingGroups[0]?.Instances || [])
    .filter((i) => i.LifecycleState === 'InService' && i.HealthStatus === 'Healthy')
    .map((i) => i.InstanceId);
  if (!ids.length) throw new Error(`No healthy in-service instance in ${process.env.ASG_NAME}.`);
  const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }));
  const instance = Reservations.flatMap((r) => r.Instances)[0];
  return { instanceId: instance.InstanceId, ip: instance.PrivateIpAddress, inService: ids.length };
}

export const handler = async (event) => {
  const { instanceId, ip, inService } = await apiServer();
  const locations = [];

  for (const report of event.reports) {
    const res = await fetch(`http://${ip}:${process.env.REPORTS_PORT}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${report.type} report failed on ${instanceId}: HTTP ${res.status} ${body.error || ''}`.trim());

    console.log(JSON.stringify({ msg: 'report.generated', type: report.type, location: body.report.location, instanceId, inService }));
    locations.push(body.report.location);
  }

  return { instanceId, locations };
};
