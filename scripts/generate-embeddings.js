require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai').default

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const openaiApiKey = process.env.OPENAI_API_KEY

if (!supabaseUrl || !supabaseKey || !openaiApiKey) {
  console.error('❌ Missing environment variables!')
  console.error('NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl ? '✓' : '✗')
  console.error('SUPABASE_SERVICE_ROLE_KEY:', supabaseKey ? '✓' : '✗')
  console.error('OPENAI_API_KEY:', openaiApiKey ? '✓' : '✗')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

async function generateEmbeddings() {
  console.log('🚀 Starting embedding generation for coatings...')
  
  let processed = 0
  const batchSize = 50
  let hasMore = true
  
  while (hasMore) {
    const { data: products, error } = await supabase
      .from('coatings')
      .select('sku, Product_Name, Product_Type, Product_Model, Product_Description, family')
      .is('embedding', null)
      .limit(batchSize)
    
    if (error) {
      console.error('❌ Error fetching products:', error)
      break
    }
    
    if (!products || products.length === 0) {
      console.log('✅ No more products without embeddings')
      hasMore = false
      break
    }
    
    console.log(`\n📦 Processing batch of ${products.length} products...`)
    
    for (const product of products) {
      try {
        const searchableText = [
          product.Product_Type,
          product.Product_Model,
          product.Product_Name,
          product.family,
          product.Product_Description,
        ]
          .filter(Boolean)
          .join(' ')
          .substring(0, 8000)
        
        console.log(`  ⚙️  Generating embedding for SKU: ${product.sku}`)
        
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: searchableText,
        })
        
        const embedding = response.data[0].embedding
        
        const { error: updateError } = await supabase
          .from('coatings')
          .update({ embedding })
          .eq('sku', product.sku)
        
        if (updateError) {
          console.error(`  ❌ Error updating SKU ${product.sku}:`, updateError)
        } else {
          processed++
          console.log(`  ✅ Updated SKU ${product.sku} (${processed} total)`)
        }
        
        await new Promise(resolve => setTimeout(resolve, 100))
        
      } catch (error) {
        console.error(`  ❌ Error processing SKU ${product.sku}:`, error)
      }
    }
  }
  
  console.log(`\n🎉 Embedding generation complete! Processed ${processed} products.`)
  process.exit(0)
}

generateEmbeddings().catch(error => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
