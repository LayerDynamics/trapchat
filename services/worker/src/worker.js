export async function processJob(job) {
  switch (job.type) {
    case 'media:chunk':
      console.log(`processing media chunk: ${job.id}`);
      // TODO: chunk media for relay distribution
      break;

    case 'room:cleanup':
      console.log(`processing room cleanup: ${job.id}`);
      // TODO: purge expired room data
      break;

    default:
      console.warn(`unknown job type: ${job.type} (${job.id})`);
  }
}
