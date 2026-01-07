import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

type ProductRecord = Record<string, any>

// ============================================================================
// CACHE SYSTEM
// ============================================================================

const CACHE_DURATION_MS = 4 * 60 * 60 * 1000 // 4 hours for product cache
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24 hours for filter cache

interface ProductCache {
  families: string[]
  productTypes: string[]
  productModels: string[]
  skus: string[]
  totalProducts: number
  lastUpdated: Date
}

let productCache: ProductCache | null = null

// Filter cache (separate from product cache)
let filterCache: {
  families: string[]
  productTypes: string[]
  productModels: string[]
  timestamp: number
  ttl: number
} | null = null

// Add a loading promise to prevent parallel loads
let cacheLoadingPromise: Promise<ProductCache> | null = null

async function loadProductCache(): Promise<ProductCache> {
  // If cache is valid, return it immediately
  if (productCache && productCache.lastUpdated) {
    const cacheAge = Date.now() - productCache.lastUpdated.getTime()
    if (cacheAge < CACHE_DURATION_MS) {
      console.log('✅ Using cached product data')
      console.log(`   Cache age: ${Math.floor(cacheAge / 1000 / 60)} minutes`)
      return productCache
    }
    console.log(`⚠️ Cache expired (age: ${Math.floor(cacheAge / 1000 / 60)} minutes)`)
  }
  
  if (cacheLoadingPromise) {
    console.log('⏳ Waiting for existing cache load...')
    return await cacheLoadingPromise
  }
  
  console.log('📋 Loading all product data from database...')
  const startTime = Date.now()
  
  cacheLoadingPromise = (async () => {
    try {
      const { count: totalCount, error: countError } = await supabase
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      if (countError) {
        console.error('❌ Error counting rows:', countError)
        throw countError
      }
      
      console.log(`📊 Total rows in database: ${totalCount}`)
      
      const BATCH_SIZE = 1000
      const totalBatches = Math.ceil((totalCount || 0) / BATCH_SIZE)
      
      console.log(`📊 Fetching ${totalBatches} batches...`)
      
      const allData: any[] = []
      
      for (let i = 0; i < totalBatches; i++) {
        const from = i * BATCH_SIZE
        const to = from + BATCH_SIZE - 1
        
        const { data, error } = await supabase
          .from('coatings')
          .select('family, Product_Type, Product_Model, sku')
          .range(from, to)
        
        if (error) {
          console.error(`❌ Error fetching batch ${i + 1}:`, error)
          throw error
        }
        
        if (data) {
          allData.push(...data)
          if ((i + 1) % 5 === 0 || i === totalBatches - 1) {
            console.log(`   ✅ Batch ${i + 1}/${totalBatches}: ${data.length} rows (total: ${allData.length})`)
          }
        }
      }
      
      console.log(`📊 Fetched ${allData.length} total rows`)
      
      if (allData.length === 0) {
        console.error('❌ No data returned from database!')
        return {
          families: [],
          productTypes: [],
          productModels: [],
          skus: [],
          totalProducts: 0,
          lastUpdated: new Date()
        }
      }
      
      const familiesRaw = allData.map(r => r.family).filter(Boolean)
      const typesRaw = allData.map(r => r.Product_Type).filter(Boolean)
      const modelsRaw = allData.map(r => r.Product_Model).filter(Boolean)
      const skusRaw = allData.map(r => r.sku).filter(Boolean)
      
      const families = [...new Set(familiesRaw)].sort()
      const productTypes = [...new Set(typesRaw)].sort()
      const productModels = [...new Set(modelsRaw)].sort()
      const skus = [...new Set(skusRaw)].sort()
      
      productCache = {
        families,
        productTypes,
        productModels,
        skus,
        totalProducts: totalCount || 0,
        lastUpdated: new Date()
      }
      
      const loadTime = Date.now() - startTime
      console.log(`✅ Cache loaded in ${loadTime}ms`)
      console.log(`   📊 ${totalCount?.toLocaleString()} total products`)
      console.log(`   👨‍👩‍👧‍👦 ${families.length} families`)
      console.log(`   📦 ${productTypes.length} product types`)
      console.log(`   📝 ${productModels.length} product models`)
      console.log(`   🏷️  ${skus.length} unique SKUs`)
      
      return productCache
      
    } finally {
      cacheLoadingPromise = null
    }
  })()
  
  return await cacheLoadingPromise
}

async function getCache(): Promise<ProductCache> {
  if (!productCache) {
    return await loadProductCache()
  }
  return productCache
}

export async function refreshCache(): Promise<void> {
  console.log('🔄 Manually refreshing cache...')
  productCache = null
  await loadProductCache()
}

// ============================================================================
// SEMANTIC SEARCH WITH EMBEDDINGS
// ============================================================================

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return response.data[0].embedding
  } catch (error) {
    console.error('❌ Error generating embedding:', error)
    throw error
  }
}

async function semanticSearch(query: string, limit: number = 150): Promise<any[]> {
  console.log('🧠 Performing semantic search...')
  
  try {
    const queryEmbedding = await generateEmbedding(query)
    
    const { data, error } = await supabase.rpc('match_coatings', {
      query_embedding: queryEmbedding,
      match_threshold: 0.65,
      match_count: limit
    })
    
    if (error) {
      console.error('❌ Semantic search error:', error)
      throw error
    }
    
    console.log(`✅ Found ${data?.length || 0} semantically similar products`)
    
    if (data && data.length > 0) {
      console.log('🏆 Top 5 semantic matches:')
      data.slice(0, 5).forEach((product: any, i: number) => {
        console.log(`  ${i + 1}. ${product.Product_Name || product.family} (similarity: ${(product.similarity * 100).toFixed(1)}%)`)
      })
    }
    
    return data || []
  } catch (error) {
    console.error('❌ Semantic search failed, will fall back to traditional search')
    return []
  }
}

// ============================================================================
// SMART MATCHING FUNCTIONS
// ============================================================================

interface MatchResult {
  matched: boolean
  value: string | null
  field: 'family' | 'sku' | 'productType' | 'productModel' | null
  confidence: number
}

async function findMatchingFamily(query: string): Promise<MatchResult> {
  const cache = await getCache()
  const queryUpper = query.toUpperCase()
  const queryLower = query.toLowerCase()
  
  for (const family of cache.families) {
    if (family.toUpperCase() === queryUpper) {
      console.log(`  ✅ Exact family match: "${family}"`)
      return { matched: true, value: family, field: 'family', confidence: 1.0 }
    }
  }
  
  for (const family of cache.families) {
    if (queryUpper.includes(family.toUpperCase())) {
      console.log(`  ✅ Family found in query: "${family}"`)
      return { matched: true, value: family, field: 'family', confidence: 0.9 }
    }
  }
  
  const cleanQuery = queryLower
    .replace(/^(which|what|show me|tell me about|give me|find me)\s+/i, '')
    .replace(/\s+(is|are)\s+/gi, ' ')
    .trim()
  
  if (cleanQuery.length >= 4) {
    for (const family of cache.families) {
      if (family.toUpperCase().includes(cleanQuery.toUpperCase())) {
        console.log(`  ✅ Partial family match: "${family}"`)
        return { matched: true, value: family, field: 'family', confidence: 0.8 }
      }
    }
  }
  
  const productCodeMatch = queryLower.match(/\b([a-z]{2,})\s*(\d{3,})([a-z]*)\b/i)
  
  if (productCodeMatch) {
    const prefix = productCodeMatch[1].toUpperCase()
    const number = productCodeMatch[2]
    const suffix = productCodeMatch[3].toUpperCase()
    
    const searchPatterns = [
      `${prefix}${number}${suffix}`,
      `${prefix} ${number}${suffix}`,
      `${prefix}-${number}${suffix}`
    ]
    
    console.log(`  🔍 Looking for product code: ${prefix}${number}${suffix}`)
    
    for (const family of cache.families) {
      const familyUpper = family.toUpperCase()
      
      for (const pattern of searchPatterns) {
        if (familyUpper.includes(pattern)) {
          console.log(`  ✅ Family matched by product code: "${family}"`)
          return { matched: true, value: family, field: 'family', confidence: 0.95 }
        }
      }
    }
  }
  
  return { matched: false, value: null, field: null, confidence: 0 }
}

async function findMatchingSKU(query: string): Promise<MatchResult> {
  const cache = await getCache()
  const queryUpper = query.toUpperCase()
  const queryClean = query.replace(/[\s\-]/g, '').toUpperCase()
  
  for (const sku of cache.skus) {
    if (sku.toUpperCase() === queryUpper) {
      console.log(`  ✅ Exact SKU match: "${sku}"`)
      return { matched: true, value: sku, field: 'sku', confidence: 1.0 }
    }
  }
  
  for (const sku of cache.skus) {
    const skuClean = sku.replace(/[\s\-]/g, '').toUpperCase()
    if (skuClean === queryClean) {
      console.log(`  ✅ SKU match (normalized): "${sku}"`)
      return { matched: true, value: sku, field: 'sku', confidence: 0.95 }
    }
  }
  
  for (const sku of cache.skus) {
    if (queryUpper.includes(sku.toUpperCase()) || sku.toUpperCase().includes(queryUpper)) {
      console.log(`  ✅ Partial SKU match: "${sku}"`)
      return { matched: true, value: sku, field: 'sku', confidence: 0.8 }
    }
  }
  
  return { matched: false, value: null, field: null, confidence: 0 }
}

async function findMatchingProductType(query: string): Promise<MatchResult> {
  const cache = await getCache()
  const queryLower = query.toLowerCase()
  
  for (const type of cache.productTypes) {
    if (type.toLowerCase() === queryLower) {
      console.log(`  ✅ Exact product type match: "${type}"`)
      return { matched: true, value: type, field: 'productType', confidence: 1.0 }
    }
  }
  
  for (const type of cache.productTypes) {
    if (queryLower.includes(type.toLowerCase())) {
      console.log(`  ✅ Product type found in query: "${type}"`)
      return { matched: true, value: type, field: 'productType', confidence: 0.9 }
    }
  }
  
  const cleanQuery = queryLower
    .replace(/^(which|what|show me|tell me about|give me|find me)\s+/i, '')
    .replace(/\s+(is|are)\s+/gi, ' ')
    .trim()
  
  if (cleanQuery.length >= 4) {
    for (const type of cache.productTypes) {
      if (type.toLowerCase().includes(cleanQuery)) {
        console.log(`  ✅ Partial product type match: "${type}"`)
        return { matched: true, value: type, field: 'productType', confidence: 0.8 }
      }
    }
  }
  
  return { matched: false, value: null, field: null, confidence: 0 }
}

async function findMatchingProductModel(query: string): Promise<MatchResult> {
  const cache = await getCache()
  const queryUpper = query.toUpperCase()
  
  for (const model of cache.productModels) {
    if (model.toUpperCase() === queryUpper) {
      console.log(`  ✅ Exact product model match: "${model}"`)
      return { matched: true, value: model, field: 'productModel', confidence: 1.0 }
    }
  }
  
  for (const model of cache.productModels) {
    if (queryUpper.includes(model.toUpperCase())) {
      console.log(`  ✅ Product model found in query: "${model}"`)
      return { matched: true, value: model, field: 'productModel', confidence: 0.9 }
    }
  }
  
  return { matched: false, value: null, field: null, confidence: 0 }
}

async function findBestMatch(query: string): Promise<MatchResult> {
  console.log('🔍 Searching cache for best match...')
  
  const results = await Promise.all([
    findMatchingFamily(query),
    findMatchingSKU(query),
    findMatchingProductType(query),
    findMatchingProductModel(query)
  ])
  
  results.sort((a, b) => b.confidence - a.confidence)
  const bestMatch = results[0]
  
  if (bestMatch.matched) {
    console.log(`🎯 Best match: ${bestMatch.field} = "${bestMatch.value}" (confidence: ${bestMatch.confidence})`)
    return bestMatch
  }
  
  console.log('❌ No match found in cache')
  return { matched: false, value: null, field: null, confidence: 0 }
}

// ============================================================================
// TERM VARIATIONS & SYNONYMS
// ============================================================================

const TERM_VARIATIONS: Record<string, string[]> = {
  'primer': ['primer', 'primers', 'priming', 'surface preparation', 'base coat'],
  'topcoat': ['topcoat', 'top coat', 'finish coat', 'final coat'],
  'coating': ['coating', 'coatings', 'protective coating', 'surface coating'],
  'corrosion': ['corrosion', 'corrosion resistant', 'corrosion protection', 'anti-corrosion'],
  'epoxy': ['epoxy', 'epoxies', 'epoxie', 'two-part', 'structural'],
  'polyurethane': ['polyurethane', 'urethane', 'pu'],
  'military': ['military', 'mil-spec', 'mil spec', 'defense', 'army', 'navy', 'air force'],
  'aerospace': ['aerospace', 'aircraft', 'aviation', 'flight'],
  'chemical resistant': ['chemical resistant', 'chemical resistance', 'solvent resistant'],
  'high temperature': ['high temperature', 'heat resistant', 'thermal'],
  'low voc': ['low voc', 'low odor', 'reduced emissions'],
  'chromate free': ['chromate free', 'non-chromate', 'chromate-free', 'chrome free']
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getComparedFields(products: ProductRecord[], onlyDifferences: boolean = false): string[] {
  if (products.length === 0) return []
  
  const excludeFields = ['embedding', 'created_at', 'updated_at', '_relevanceScore', '_sourceTable', 'searchable_text', 'searchabletext']
  
  const allKeys = new Set<string>()
  products.forEach(product => {
    Object.keys(product).forEach(key => {
      if (!excludeFields.includes(key.toLowerCase())) {
        allKeys.add(key)
      }
    })
  })
  
  const fields = Array.from(allKeys).sort()
  
  // ✅ If onlyDifferences is true, filter to show only fields with different values
  if (onlyDifferences) {
    return fields.filter(field => {
      const values = products.map(p => p[field])
      const uniqueValues = new Set(values.map(v => JSON.stringify(v)))
      return uniqueValues.size > 1 // Only keep fields where values differ
    })
  }
  
  return fields
}

function detectMetaQuestion(query: string): { isMeta: boolean; type: string | null } {
  const lowerQuery = query.toLowerCase().trim()
  const hasSpecificProduct = /\b([a-z]{2,}\s*\d{3,}|[0-9][a-z0-9]{4,})\b/i.test(query)
  
  if (
    (lowerQuery === 'how many products' ||
     lowerQuery === 'how many products are in the system' ||
     lowerQuery === 'how many products in database' ||
     lowerQuery === 'how many products are there' ||
     lowerQuery === 'total products' ||
     lowerQuery === 'count products' ||
     lowerQuery === 'how many items' ||
     lowerQuery === 'total number of products') &&
    !hasSpecificProduct
  ) {
    console.log('🎯 Detected generic count query (no specific product)')
    return { isMeta: true, type: 'count' }
  }
  
  if (
    lowerQuery.match(/what (are the |kinds of |types of )?(families|family|types?|categories)/) ||
    lowerQuery.match(/list (all )?(families|family|types?|categories|products?)/) ||
    lowerQuery.match(/show (me )?(all )?(families|family|types?|categories)/)
  ) {
    return { isMeta: true, type: 'list' }
  }
  
  if (
    lowerQuery.match(/what('s| is) in (the |this )?database/) ||
    lowerQuery.match(/tell me about (the |this )?database/) ||
    lowerQuery.match(/database (info|information|overview|summary)/)
  ) {
    return { isMeta: true, type: 'overview' }
  }
  
  return { isMeta: false, type: null }
}

async function handleMetaQuestion(type: string, query: string, filters: any): Promise<any> {
  console.log(`🔍 Handling meta-question type: ${type}`)
  
  try {
    if (type === 'count') {
      try {
        console.log('📊 Counting products...')
        
        let countQuery = supabase
          .from('coatings')
          .select('*', { count: 'exact', head: true })
        
        if (filters?.family) {
          console.log(`  🔍 Filter: family = "${filters.family}"`)
          countQuery = countQuery.eq('family', filters.family)
        }
        if (filters?.productType) {
          console.log(`  🔍 Filter: Product_Type = "${filters.productType}"`)
          countQuery = countQuery.eq('Product_Type', filters.productType)
        }
        if (filters?.productModel) {
          console.log(`  🔍 Filter: Product_Model = "${filters.productModel}"`)
          countQuery = countQuery.eq('Product_Model', filters.productModel)
        }
        
        const { count: totalCount, error: countError } = await countQuery
        
        if (countError) {
          console.error('❌ Error counting products:', countError)
          throw new Error(`Database error: ${countError.message || 'Could not count products'}`)
        }
        
        console.log(`✅ Total products: ${totalCount?.toLocaleString()}`)
        
        console.log('📊 Loading cache for accurate statistics...')
        const cache = await getCache()
        
        console.log(`📊 Accurate statistics from cache:`)
        console.log(`   - ${cache.families.length} unique families`)
        console.log(`   - ${cache.productTypes.length} unique product types`)
        console.log(`   - ${cache.productModels.length} unique product models`)
        console.log(`   - ${cache.skus.length} unique SKUs`)
        
        console.log(`📊 Fetching 200 sample products for display...`)
        
        let sampleQuery = supabase
          .from('coatings')
          .select('*')
          .limit(200)
        
        if (filters?.family) sampleQuery = sampleQuery.eq('family', filters.family)
        if (filters?.productType) sampleQuery = sampleQuery.eq('Product_Type', filters.productType)
        if (filters?.productModel) sampleQuery = sampleQuery.eq('Product_Model', filters.productModel)
        
        const { data: sampleData, error: sampleError } = await sampleQuery
        
        if (sampleError) {
          console.error('❌ Error fetching samples:', sampleError)
        }
        
        const cleanedSamples = (sampleData || []).map((p: any) => cleanProductData(p))
        console.log(`✅ Fetched ${cleanedSamples.length} sample products for display`)
        
        const aiSummary = await generateCountSummary(
          totalCount || 0,
          cache,
          cleanedSamples,
          query
        )
        
        return {
          success: true,
          questionType: 'analytical',
          metaType: 'count',
          summary: aiSummary,
          aiAnswer: aiSummary,
          count: totalCount,
          results: cleanedSamples.slice(0, 50),
          totalResults: totalCount,
          displayedResults: Math.min(50, cleanedSamples.length),
          statistics: {
            totalProducts: totalCount,
            totalFamilies: cache.families.length,
            totalProductTypes: cache.productTypes.length,
            totalProductModels: cache.productModels.length,
            totalSkus: cache.skus.length,
            missingSkus: totalCount! - cache.skus.length
          },
          message: `Analysis based on ${totalCount?.toLocaleString()} total products`
        }
      } catch (error: any) {
        console.error('❌ Count error:', error)
        throw error
      }
    }
    
    if (type === 'list') {
      console.log('📋 Handling list query...')
      
      const cache = await getCache()
      
      const summary = `**Available Product Categories**

**Product Families (${cache.families.length} total):**
${cache.families.slice(0, 30).map(f => `- ${f}`).join('\n')}
${cache.families.length > 30 ? `\n_...and ${cache.families.length - 30} more families_` : ''}

**Product Types (${cache.productTypes.length} total):**
${cache.productTypes.slice(0, 20).map(t => `- ${t}`).join('\n')}
${cache.productTypes.length > 20 ? `\n_...and ${cache.productTypes.length - 20} more types_` : ''}

Use filters or search to explore specific products.`
      
      return {
        success: true,
        questionType: 'analytical',
        metaType: 'list',
        summary: summary,
        aiAnswer: summary,
        results: [],
        count: 0
      }
    }
    
    if (type === 'overview') {
      console.log('📊 Handling overview query...')
      
      const cache = await getCache()
      
      const summary = `**Database Overview**

**Total Statistics:**
- **Product Families:** ${cache.families.length}
- **Product Types:** ${cache.productTypes.length}
- **Product Models:** ${cache.productModels.length}
- **Total SKUs:** ${cache.skus.length}

**Capabilities:**
- Search across all product specifications
- Compare products side-by-side
- Filter by family, type, and model
- AI-powered semantic search
- Detailed technical specifications

Ask me about specific products, comparisons, or use filters to explore!`
      
      return {
        success: true,
        questionType: 'analytical',
        metaType: 'overview',
        summary: summary,
        aiAnswer: summary,
        results: [],
        count: 0
      }
    }
    
  } catch (error: any) {
    console.error('❌ Meta-question handler error:', error)
    throw error
  }
  
  return null
}

async function generateCountSummary(
  count: number, 
  cache: ProductCache, 
  sampleProducts: ProductRecord[], 
  query: string
): Promise<string> {
  try {
    const familyList = cache.families.slice(0, 20)
    const typeList = cache.productTypes.slice(0, 20)
    
    console.log(`📊 Generating summary with accurate statistics:`)
    console.log(`   - Total products: ${count.toLocaleString()}`)
    console.log(`   - ${cache.families.length} unique families`)
    console.log(`   - ${cache.productTypes.length} unique product types`)
    console.log(`   - ${cache.productModels.length} unique product models`)
    console.log(`   - ${cache.skus.length} unique SKUs (non-null)`)
    
    const missingSkus = count - cache.skus.length
    const skuCoverage = ((cache.skus.length / count) * 100).toFixed(1)
    
    const summary = `**Product Database Overview**

I found **${count.toLocaleString()} products** in the system.

**Database Statistics:**
- **Total Products:** ${count.toLocaleString()}
- **Product Families:** ${cache.families.length} unique families
- **Product Types:** ${cache.productTypes.length} unique types
- **Product Models:** ${cache.productModels.length} unique models
- **Unique SKUs:** ${cache.skus.length.toLocaleString()} (${skuCoverage}% coverage)${missingSkus > 0 ? `\n  - _Note: ${missingSkus.toLocaleString()} products have missing or duplicate SKUs_` : ''}

**Top Product Families (showing ${Math.min(familyList.length, 20)} of ${cache.families.length}):**
${familyList.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${cache.families.length > 20 ? `\n_...and ${cache.families.length - 20} more families_` : ''}

**Product Types Available (showing ${Math.min(typeList.length, 20)} of ${cache.productTypes.length}):**
${typeList.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${cache.productTypes.length > 20 ? `\n_...and ${cache.productTypes.length - 20} more types_` : ''}

**What You Can Do:**
- Search for specific products by name, SKU, or family
- Compare products side-by-side
- Filter by family, type, or model
- Get detailed technical specifications
- Use AI-powered semantic search

Try searching for a specific product family or type to explore the catalog!`
    
    return summary
  } catch (error) {
    console.error('❌ Error generating count summary:', error)
    return `**Product Count**\n\nI found **${count.toLocaleString()} products** in the system.\n\nUse filters or search to explore specific products.`
  }
}

function detectSKUAnalysisQuery(query: string): boolean {
  const lowerQuery = query.toLowerCase()
  const patterns = [
    /\b(missing|null|empty|blank)\s+(sku|skus)\b/i,
    /\b(duplicate|duplicated|repeated)\s+(sku|skus)\b/i,
    /\bsku\s+(missing|duplicate|duplicated|issues|problems)\b/i,
    /\bproducts?\s+with(out)?\s+(missing|duplicate|no)\s+sku/i,
    /\bshow\s+me\s+(missing|duplicate)\s+sku/i
  ]
  
  return patterns.some(pattern => pattern.test(lowerQuery))
}

async function analyzeSKUs(query: string): Promise<any> {
  console.log('🔍 Analyzing SKUs for missing/duplicate values...')
  
  try {
    const lowerQuery = query.toLowerCase()
    const checkMissing = /missing|null|empty|blank|without/i.test(lowerQuery)
    const checkDuplicate = /duplicate|duplicated|repeated/i.test(lowerQuery)
    
    const { count: totalCount } = await supabase
      .from('coatings')
      .select('*', { count: 'exact', head: true })
    
    console.log(`📊 Total products: ${totalCount}`)
    
    const BATCH_SIZE = 1000
    const totalBatches = Math.ceil((totalCount || 0) / BATCH_SIZE)
    
    const allProducts: any[] = []
    const skuMap = new Map<string, any[]>()
    const missingSkuProducts: any[] = []
    
    for (let i = 0; i < totalBatches; i++) {
      const from = i * BATCH_SIZE
      const to = from + BATCH_SIZE - 1
      
      const { data, error } = await supabase
        .from('coatings')
        .select('sku, family, Product_Name, Product_Type, Product_Description, Enabled')
        .range(from, to)
      
      if (error) {
        console.error(`❌ Error fetching batch ${i + 1}:`, error)
        continue
      }
      
      if (data) {
        data.forEach(product => {
          allProducts.push(product)
          
          if (!product.sku || product.sku.trim() === '') {
            missingSkuProducts.push(product)
          } else {
            const sku = product.sku.trim()
            if (!skuMap.has(sku)) {
              skuMap.set(sku, [])
            }
            skuMap.get(sku)!.push(product)
          }
        })
      }
      
      if ((i + 1) % 10 === 0 || i === totalBatches - 1) {
        console.log(`   ✅ Processed batch ${i + 1}/${totalBatches}`)
      }
    }
    
    const duplicateSkus = Array.from(skuMap.entries())
      .filter(([sku, products]) => products.length > 1)
      .map(([sku, products]) => ({
        sku,
        count: products.length,
        products: products
      }))
    
    console.log(`📊 Analysis complete:`)
    console.log(`   - Total products: ${allProducts.length}`)
    console.log(`   - Missing SKUs: ${missingSkuProducts.length}`)
    console.log(`   - Duplicate SKUs: ${duplicateSkus.length}`)
    
    let results: any[] = []
    let summaryParts: string[] = []
    
    if (checkMissing && missingSkuProducts.length > 0) {
      results.push(...missingSkuProducts.slice(0, 50))
      summaryParts.push(`**Products with Missing SKUs: ${missingSkuProducts.length}**\n\n${
        missingSkuProducts.slice(0, 10).map((p, i) => 
          `${i + 1}. **${p.Product_Name || 'Unnamed Product'}**\n   - Family: ${p.family || 'N/A'}\n   - Type: ${p.Product_Type || 'N/A'}\n   - Description: ${p.Product_Description || 'N/A'}`
        ).join('\n\n')
      }${missingSkuProducts.length > 10 ? `\n\n_...and ${missingSkuProducts.length - 10} more products with missing SKUs_` : ''}`)
    }
    
    if (checkDuplicate && duplicateSkus.length > 0) {
      duplicateSkus.slice(0, 20).forEach(({ sku, products }) => {
        results.push(...products)
      })
      
      summaryParts.push(`**Duplicate SKUs Found: ${duplicateSkus.length}**\n\n${
        duplicateSkus.slice(0, 10).map(({ sku, count, products }, i) => 
          `${i + 1}. **SKU: ${sku}** (appears ${count} times)\n${
            products.map((p, j) => 
              `   ${String.fromCharCode(97 + j)}. ${p.Product_Name || 'Unnamed'}\n      - Family: ${p.family}\n      - Type: ${p.Product_Type}\n      - Description: ${p.Product_Description?.substring(0, 80)}...`
            ).join('\n')
          }`
        ).join('\n\n')
      }${duplicateSkus.length > 10 ? `\n\n_...and ${duplicateSkus.length - 10} more duplicate SKUs_` : ''}`)
    }
    
    if (summaryParts.length === 0) {
      summaryParts.push(`**SKU Analysis Results**\n\n✅ **No issues found!**\n\n- Total products: ${allProducts.length.toLocaleString()}\n- Products with missing SKUs: ${missingSkuProducts.length}\n- Duplicate SKUs: ${duplicateSkus.length}\n\nAll products have valid, unique SKUs.`)
    }
    
    const aiSummary = `**SKU Analysis Report**\n\n**Summary:**\n- Total Products Analyzed: ${allProducts.length.toLocaleString()}\n- Products with Missing SKUs: ${missingSkuProducts.length}\n- Duplicate SKUs: ${duplicateSkus.length}\n- Unique SKUs: ${skuMap.size.toLocaleString()}\n\n${summaryParts.join('\n\n---\n\n')}\n\n**Note:** Each product should have a unique SKU for proper inventory management.`
    
    return {
      success: true,
      questionType: 'analytical',
      metaType: 'sku_analysis',
      summary: aiSummary,
      aiAnswer: aiSummary,
      results: results.slice(0, 100).map(cleanProductData),
      totalResults: results.length,
      displayedResults: Math.min(50, results.length),
      statistics: {
        totalProducts: allProducts.length,
        missingSkus: missingSkuProducts.length,
        duplicateSkus: duplicateSkus.length,
        uniqueSkus: skuMap.size
      }
    }
    
  } catch (error: any) {
    console.error('❌ SKU analysis error:', error)
    throw error
  }
}

interface ComparisonExtraction {
  isComparison: boolean
  productCodes: string[]
  potentialSkus: string[]
}

function extractComparisonProducts(query: string): ComparisonExtraction {
  const lowerQuery = query.toLowerCase()
  
  const comparisonKeywords = [
    'compare', 'comparison', 'vs', 'versus', 'difference between',
    'which is better', 'compare to', 'compared to', 'against',
    'or', 'between', 'with'
  ]
  
  const isComparison = comparisonKeywords.some(keyword => lowerQuery.includes(keyword))
  
  if (!isComparison) {
    return {
      isComparison: false,
      productCodes: [],
      potentialSkus: []
    }
  }
  
  console.log('🎯 Detected comparison query')
  
  const potentialSkus: string[] = []
  const productCodes: string[] = []
  
  // ✅ IMPROVED: Better pattern for product codes like 020X411
  const productCodePattern = /\b(\d{3}[A-Z]\d{3})\b/gi
  let match
  
  while ((match = productCodePattern.exec(query)) !== null) {
    const code = match[1].toUpperCase()
    productCodes.push(code)
    console.log(`  📦 Found product code: ${code}`)
  }
  
  // Also check for SKU patterns
  const skuPattern1 = /\b([A-Z0-9]{4,}[\/\-][A-Z0-9]{2,}[A-Z0-9]{3,})\b/gi
  let skuMatch1
  while ((skuMatch1 = skuPattern1.exec(query)) !== null) {
    potentialSkus.push(skuMatch1[1])
    console.log(`  📦 Found potential SKU: ${skuMatch1[1]}`)
  }
  
  console.log(`🔍 Comparison detection summary:`)
  console.log(`   - Product codes found: ${productCodes.length} [${productCodes.join(', ')}]`)
  console.log(`   - Potential SKUs found: ${potentialSkus.length} [${potentialSkus.join(', ')}]`)
  
  return {
    isComparison: true,
    productCodes,
    potentialSkus
  }
}

function detectPhrases(query: string): string[] {
  const phrases: string[] = []
  const lowerQuery = query.toLowerCase()
  
  const technicalPhrases = [
    'corrosion resistant',
    'corrosion protection',
    'chemical resistant',
    'high temperature',
    'low temperature',
    'low voc',
    'chromate free',
    'epoxy primer',
    'polyurethane topcoat',
    'military specification',
    'mil spec',
    'aerospace grade',
    'clear coat',
    'clear topcoat'
  ]
  
  for (const phrase of technicalPhrases) {
    if (lowerQuery.includes(phrase)) {
      phrases.push(phrase)
      console.log(`  🔍 Detected phrase: "${phrase}"`)
    }
  }
  
  return phrases
}

function expandSearchTerms(query: string): string[] {
  const lowerQuery = query.toLowerCase()
  
  const detectedPhrases = detectPhrases(query)
  
  const cleanedQuery = lowerQuery
    .replace(/^(which|what|show me|tell me about|give me|find me|list|search for|looking for|i need|i want)\s+/i, '')
    .replace(/\s+(is|are|was|were|be|been|being)\s+/gi, ' ')
    .replace(/\s+(a|an|the)\s+/gi, ' ')
    .replace(/\s+(for|to|of|in|on|at|by|with)\s+/gi, ' ')
    .replace(/[?!.,;:()]/g, ' ')
    .trim()
  
  console.log(`  🧹 Cleaned query: "${cleanedQuery}"`)
  
  const words = cleanedQuery
    .split(/\s+/)
    .filter(word => word.length > 2)
    .filter(word => !['coating', 'coatings', 'product', 'products', 'item', 'items'].includes(word))
  
  console.log(`  📝 Extracted words:`, words)
  
  const expandedTerms = new Set<string>()
  
  detectedPhrases.forEach(phrase => {
    expandedTerms.add(phrase)
    
    if (TERM_VARIATIONS[phrase]) {
      TERM_VARIATIONS[phrase].forEach(variation => expandedTerms.add(variation))
    }
  })
  
  words.forEach(word => expandedTerms.add(word))
  
  words.forEach(word => {
    if (TERM_VARIATIONS[word]) {
      TERM_VARIATIONS[word].forEach(variation => expandedTerms.add(variation))
    } else {
      if (word.endsWith('y')) {
        expandedTerms.add(word.slice(0, -1) + 'ies')
      } else if (!word.endsWith('s')) {
        expandedTerms.add(word + 's')
      }
    }
  })
  
  if (cleanedQuery.length > 5) {
    expandedTerms.add(cleanedQuery)
  }
  
  const finalTerms = Array.from(expandedTerms)
  console.log(`  ✅ Final expanded terms (${finalTerms.length}):`, finalTerms)
  
  return finalTerms
}

function classifyIntent(query: string): {
  intent: 'specific' | 'comparison' | 'analytical' | 'meta' | 'general'
  confidence: number
} {
  const queryLower = query.toLowerCase()
  
  // 1. Check for specific product lookup (SKU or exact product code)
  // Pattern: alphanumeric codes like "020X411", "CA7233", "99-36270"
  const productCodePattern = /\b[a-z0-9]{2,}[-\s]?[0-9]{3,}[a-z0-9]*\b/i
  const isProductCode = productCodePattern.test(query)
  
  // Also check if query matches a known family exactly
  const cache = productCache
  if (cache) {
    const queryUpper = query.toUpperCase().trim()
    const exactFamilyMatch = cache.families.some(f => 
      f.toUpperCase() === queryUpper
    )
    
    if (exactFamilyMatch || isProductCode) {
      console.log('🎯 Detected as SPECIFIC product lookup')
      return { intent: 'specific', confidence: 0.95 }
    }
  }
  
  // 2. Check for comparison intent
  const comparisonKeywords = [
    'compare', 'comparison', 'versus', 'vs', 'difference between',
    'better than', 'which is better', 'or', 'between'
  ]
  
  const hasComparisonKeyword = comparisonKeywords.some(keyword => 
    queryLower.includes(keyword)
  )
  
  // Count "or" and product-like terms to detect comparison
  const orCount = (queryLower.match(/\bor\b/g) || []).length
  const hasMultipleProducts = orCount > 0 || 
    (queryLower.match(/\b[a-z0-9]{2,}[-\s]?[0-9]{3,}/gi) || []).length > 1
  
  if (hasComparisonKeyword || (orCount > 0 && hasMultipleProducts)) {
    console.log('🎯 Detected as COMPARISON query')
    return { intent: 'comparison', confidence: 0.9 }
  }
  
  // 3. Check for analytical intent
  const analyticalKeywords = [
    'how many', 'count', 'list all', 'show all', 'what are all',
    'which products', 'available', 'options', 'types of'
  ]
  
  const hasAnalyticalKeyword = analyticalKeywords.some(keyword =>
    queryLower.includes(keyword)
  )
  
  if (hasAnalyticalKeyword) {
    console.log('🎯 Detected as ANALYTICAL query')
    return { intent: 'analytical', confidence: 0.85 }
  }
  
  // 4. Check for meta questions (about the system/database)
  const metaKeywords = [
    'what is', 'what are', 'tell me about', 'explain',
    'how does', 'what does', 'definition', 'meaning'
  ]
  
  const hasMetaKeyword = metaKeywords.some(keyword =>
    queryLower.includes(keyword)
  )
  
  if (hasMetaKeyword && !isProductCode) {
    console.log('🎯 Detected as META question')
    return { intent: 'meta', confidence: 0.8 }
  }
  
  // 5. Default to general search
  console.log('🎯 Detected as GENERAL search')
  return { intent: 'general', confidence: 0.5 }
}

function stripHtml(html: string): string {
  if (typeof html !== 'string') return html
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&deg;/g, '°')
    .replace(/&reg;/g, '®')
    .replace(/&copy;/g, '©')
    .replace(/&trade;/g, '™')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim()
}

function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  const seen = new Set<string>()
  
  Object.keys(product).forEach(key => {
    const lowerKey = key.toLowerCase()
    
    if (seen.has(lowerKey) || key === 'embedding' || key === 'similarity') return
    seen.add(lowerKey)
    
    const value = product[key]
    if (value === null || value === undefined || value === '') return
    
    if (typeof value === 'string') {
      const cleanedValue = stripHtml(value)
      if (cleanedValue) cleaned[key] = cleanedValue
    } else {
      cleaned[key] = value
    }
  })
  
  return cleaned
}

function scoreProductRelevance(product: ProductRecord, keywords: string[], debug: boolean = false): number {
  let score = 0
  const matchedKeywords = new Set<string>()
  
  const name = (product.Product_Name || product.name || '').toLowerCase()
  const sku = (product.sku || '').toLowerCase()
  const family = (product.family || '').toLowerCase()
  const productType = (product.Product_Type || '').toLowerCase()
  const productModel = (product.Product_Model || '').toLowerCase()
  const description = (product.Product_Description || product.description || '').toLowerCase()
  
  const genericTerms = [
    'coating', 'coatings',
    'product', 'products',
    'item', 'items',
    'primer', 'primers',
    'topcoat', 'topcoats'
  ]
  
  const phrases = keywords.filter(k => k.includes(' '))
  const singleWords = keywords.filter(k => !k.includes(' '))
  
  const primaryKeywords = singleWords.filter(k => !genericTerms.includes(k.toLowerCase()))
  
  if (debug) {
    console.log(`  🔍 Detected phrases:`, phrases)
    console.log(`  🔍 Primary keywords for scoring:`, primaryKeywords)
  }
  
  let phraseMatches = 0
  phrases.forEach(phrase => {
    const lower = phrase.toLowerCase()
    let matched = false
    let phraseScore = 0
    
    if (name.includes(lower)) {
      phraseScore += 500
      matched = true
    }
    if (productType.includes(lower)) {
      phraseScore += 800
      matched = true
    }
    if (family.includes(lower)) {
      phraseScore += 400
      matched = true
    }
    if (description.includes(lower)) {
      phraseScore += 100
      matched = true
    }
    
    if (matched) {
      matchedKeywords.add(lower)
      score += phraseScore
      phraseMatches++
      if (debug) {
        console.log(`  ✅ Phrase "${phrase}" matched - score: +${phraseScore}`)
      }
    }
  })
  
  if (phraseMatches > 0) {
    if (debug) {
      console.log(`  ✅ ${phraseMatches} phrase(s) matched - allowing product`)
    }
  } else {
    let primaryMatches = 0
    
    primaryKeywords.forEach(keyword => {
      const lower = keyword.toLowerCase()
      
      if (name.includes(lower) || 
          sku.includes(lower) || 
          family.includes(lower) || 
          productType.includes(lower) ||
          productModel.includes(lower) ||
          description.includes(lower)) {
        primaryMatches++
      }
    })
    
    if (primaryKeywords.length > 0 && primaryMatches === 0) {
      if (debug) {
        console.log(`  ❌ Product "${name}" has no primary keyword matches - score: 0`)
      }
      return 0
    }
  }
  
  if (primaryKeywords.length === 0 && phrases.length === 0) {
    if (debug) {
      console.log(`  ℹ️ No primary keywords or phrases, scoring all matches`)
    }
  }
  
  if (primaryKeywords.length > 0) {
    let primaryMatches = 0
    primaryKeywords.forEach(keyword => {
      const lower = keyword.toLowerCase()
      if (name.includes(lower) || sku.includes(lower) || family.includes(lower) || 
          productType.includes(lower) || productModel.includes(lower) || 
          description.includes(lower)) {
        primaryMatches++
      }
    })
    
    if (primaryMatches === primaryKeywords.length) {
      score += 1000
      if (debug) {
        console.log(`  ✅ Product "${name}" matches ALL primary keywords - bonus: +1000`)
      }
    }
  }
  
  singleWords.forEach(keyword => {
    const lower = keyword.toLowerCase()
    
    if (matchedKeywords.has(lower)) return
    
    let matched = false
    let keywordScore = 0
    
    if (name.includes(lower)) {
      keywordScore += 300
      matched = true
    }
    if (sku.includes(lower)) {
      keywordScore += 250
      matched = true
    }
    if (family.includes(lower)) {
      keywordScore += 250
      matched = true
    }
    if (productType.includes(lower)) {
      keywordScore += 200
      matched = true
    }
    if (productModel.includes(lower)) {
      keywordScore += 200
      matched = true
    }
    if (description.includes(lower)) {
      keywordScore += 50
      matched = true
    }
    
    if (matched) {
      matchedKeywords.add(lower)
      score += keywordScore
    }
  })
  
  return score
}

function buildComparisonTable(products: ProductRecord[]): string {
  const rows: Array<{ spec: string; values: string[] }> = []
  
  const specs = [
    { keys: ['Mix_Ratio', 'mix_ratio', 'mixing_ratio', 'Mix_Ratio_by_Volume'], label: 'Mix Ratio' },
    { keys: ['Pot_Life', 'pot_life', 'working_time', 'Pot_Life_Hours'], label: 'Pot Life' },
    { keys: ['Cure_Time', 'cure_time', 'dry_time', 'Full_Cure_Time_Hours'], label: 'Cure Time' },
    { keys: ['VOC_Content', 'voc_content', 'voc', 'VOC_Actual_gL'], label: 'VOC Content' },
    { keys: ['Color', 'color', 'colour'], label: 'Color' },
    { keys: ['Gloss', 'gloss', 'finish'], label: 'Gloss' },
    { keys: ['Application_Method', 'application_method', 'application'], label: 'Application Method' },
    { keys: ['Coverage', 'coverage', 'spread_rate', 'Theoretical_Coverage_ft2gal'], label: 'Coverage' },
    { keys: ['Temperature_Range', 'temperature_range', 'service_temp'], label: 'Temperature Range' }
  ]
  
  specs.forEach(spec => {
    const values = products.map(product => {
      for (const key of spec.keys) {
        const value = product[key] || 
                     product[key.replace(/_/g, ' ')] ||
                     product[key.replace(/ /g, '_')]
        
        if (value) {
          return String(value).trim()
        }
      }
      return 'N/A'
    })
    
    if (values.some(v => v !== 'N/A')) {
      rows.push({ spec: spec.label, values })
    }
  })
  
  const productNames = products.map(p => 
    p.Product_Name || p.name || p.family || 'Unknown'
  )
  
  let table = '\n## Key Specifications\n\n'
  table += '| Specification | ' + productNames.join(' | ') + ' |\n'
  table += '|' + Array(productNames.length + 1).fill('---').join('|') + '|\n'
  
  rows.forEach(row => {
    table += '| ' + row.spec + ' | ' + row.values.join(' | ') + ' |\n'
  })
  
  table += '\n'
  
  return table
}

async function generateAISummary(query: string, products: ProductRecord[]): Promise<string> {
  try {
    const productsData = products.slice(0, 20).map(p => {
      const { embedding, ...rest } = p
      return JSON.stringify(rest, null, 2)
    }).join('\n\n---\n\n')
    
    console.log(`🤖 Generating AI summary from ${products.length} products`)
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert aerospace coatings consultant. Provide clear, comprehensive answers based on the product data.

GUIDELINES:
- Start with a direct answer
- List specific products with SKUs
- Explain key features and applications
- Include technical specifications
- Compare products when relevant
- Be concise but thorough

PRODUCT DATA (${products.length} products):
${productsData}`
        },
        {
          role: 'user',
          content: query
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })
    
    return stripHtml(completion.choices[0].message.content || 'Unable to generate summary')
  } catch (error: any) {
    console.error('❌ AI summary error:', error.message)
    return 'Unable to generate AI summary. Please review the product details below.'
  }
}

// Helper function to format attribute names nicely
function formatAttributeName(attr: string): string {
  return attr
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

async function generateComparisonAnalysis(products: ProductRecord[], query: string): Promise<string> {
  try {
    const excludeFields = ['embedding', 'created_at', 'updated_at', '_relevanceScore', '_sourceTable', 'searchable_text', 'searchabletext']
    
    const allAttributes = new Set<string>()
    products.forEach(product => {
      Object.keys(product).forEach(key => {
        if (!excludeFields.includes(key.toLowerCase()) && product[key] !== null && product[key] !== undefined) {
          allAttributes.add(key)
        }
      })
    })
    
    const comparisonData = Array.from(allAttributes).map(attr => {
      const values = products.map(p => p[attr])
      const allSame = values.every(v => v === values[0])
      
      return {
        attribute: attr,
        values: values,
        differs: !allSame
      }
    })
    
    const differingAttrs = comparisonData.filter(item => item.differs)
    const sameAttrs = comparisonData.filter(item => !item.differs)
    
    console.log(`📊 Comparison stats: ${differingAttrs.length} differing attributes, ${sameAttrs.length} same attributes`)
    
    const productSummaries = products.map((product, idx) => {
      const name = product.Product_Name || product.family || `Product ${idx + 1}`
      const sku = product.sku || 'N/A'
      const family = product.family || 'N/A'
      
      return `**Product ${idx + 1}: ${name}**\n- SKU: ${sku}\n- Family: ${family}`
    }).join('\n\n')
    
    const differencesSection = differingAttrs.length > 0 ? 
      `\n\n### Key Differences (${differingAttrs.length} attributes differ)\n\n` +
      differingAttrs.slice(0, 20).map(item => {
        const attrName = formatAttributeName(item.attribute)
        const valueComparison = products.map((p, idx) => 
          `  - **Product ${idx + 1}:** ${item.values[idx] || 'N/A'}`
        ).join('\n')
        
        return `**${attrName}:**\n${valueComparison}`
      }).join('\n\n')
      : '\n\n*No differences found - products are identical.*'
    
    const similaritiesSection = sameAttrs.length > 0 ?
      `\n\n### Similarities (${sameAttrs.length} attributes are the same)\n\n` +
      sameAttrs.slice(0, 15).map(item => 
        `- **${formatAttributeName(item.attribute)}:** ${item.values[0] || 'N/A'}`
      ).join('\n') +
      (sameAttrs.length > 15 ? `\n- *...and ${sameAttrs.length - 15} more shared attributes*` : '')
      : ''

    const prompt = `You are comparing ${products.length} coating products. Provide a comprehensive technical comparison.

${productSummaries}

${differencesSection}

${similaritiesSection}

Please provide a detailed analysis with these sections:

1. **Overview**: Brief summary of what these products are and their primary purpose
2. **Critical Differences**: Highlight the 10-15 most important technical differences that would affect product selection
3. **Performance Characteristics**: Compare key performance attributes (if available)
4. **Application Recommendations**: When to use each product based on the differences
5. **Summary**: Quick decision guide

Format your response in clear markdown with bullet points. Focus on technical specifications and practical differences.`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a technical product comparison expert specializing in industrial coatings. Provide detailed, accurate comparisons focusing on specifications and practical differences. Always include comprehensive technical details and explain what the differences mean for end users.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 3000
    })

    const analysis = completion.choices[0]?.message?.content || 'Unable to generate comparison analysis.'
    
    console.log(`✅ Generated comparison analysis (${analysis.length} characters)`)
    
    return analysis

  } catch (error) {
    console.error('❌ Error generating comparison analysis:', error)
    return `**Comparison Analysis**\n\nComparing ${products.length} products:\n\n${
      products.map((p, i) => `${i + 1}. ${p.Product_Name || p.family || 'Unknown'} (SKU: ${p.sku || 'N/A'})`).join('\n')
    }\n\n*Detailed analysis unavailable.*`
  }
}

// ============================================================================
// COMPARISON QUERY HANDLERS
// ============================================================================

async function handleComparisonQuery(query: string, productCodes: string[]): Promise<NextResponse> {
  console.log('🎯 Processing comparison query for:', productCodes)
  
  try {
    const cache = await getCache()
    console.log('✅ Cache loaded for comparison')
    
    const matchedProducts: ProductRecord[] = []
    const notFoundCodes: string[] = []
    
    for (const code of productCodes) {
      console.log(`  🔎 Searching for: ${code}`)
      
      let found = false
      
      // ============================================================================
      // METHOD 1: Exact Family Match
      // ============================================================================
      const familyMatches = cache.families.filter(f => {
        const fUpper = f.toUpperCase()
        const codeUpper = code.toUpperCase()
        const fClean = fUpper.replace(/[\s\-\/®™©]/g, '')
        const codeClean = codeUpper.replace(/[\s\-\/®™©]/g, '')
        return fClean === codeClean || fClean.includes(codeClean) || codeClean.includes(fClean)
      })
      
      console.log(`  📋 Found ${familyMatches.length} family matches for ${code}:`, familyMatches.slice(0, 5))
      
      if (familyMatches.length > 0) {
        const { data, error } = await supabase
          .from('coatings')
          .select('*')
          .eq('family', familyMatches[0])
          .limit(1)
        
        if (!error && data && data.length > 0) {
          console.log(`  ✅ Found product for ${code}: ${data[0].Product_Name || data[0].family}`)
          matchedProducts.push(cleanProductData(data[0]))
          found = true
          continue
        }
      }
      
      // ============================================================================
      // METHOD 2: Fuzzy Family Match (for codes like 020X456 that don't exist)
      // ============================================================================
      if (!found) {
        console.log(`  🔍 Trying fuzzy family match for ${code}...`)
        
        // Extract pattern: e.g., "020X456" -> "020X" prefix, "456" number
        const patternMatch = code.match(/^([A-Z0-9]{3,5})([0-9]{2,4})([A-Z]*)$/i)
        
        if (patternMatch) {
          const prefix = patternMatch[1].toUpperCase()
          const number = patternMatch[2]
          const suffix = patternMatch[3].toUpperCase()
          
          console.log(`  🔍 Pattern: prefix="${prefix}", number="${number}", suffix="${suffix}"`)
          
          // Find families with same prefix
          const similarFamilies = cache.families.filter(f => {
            const fUpper = f.toUpperCase().replace(/[\s\-\/®™©]/g, '')
            return fUpper.startsWith(prefix)
          })
          
          console.log(`  📋 Found ${similarFamilies.length} families with prefix "${prefix}":`, similarFamilies.slice(0, 10))
          
          if (similarFamilies.length > 0) {
            // Try to find closest match by number
            const codeNumber = parseInt(number)
            let closestFamily = similarFamilies[0]
            let smallestDiff = Infinity
            
            similarFamilies.forEach(f => {
              const fMatch = f.match(/(\d{2,4})/)
              if (fMatch) {
                const fNumber = parseInt(fMatch[1])
                const diff = Math.abs(fNumber - codeNumber)
                if (diff < smallestDiff) {
                  smallestDiff = diff
                  closestFamily = f
                }
              }
            })
            
            console.log(`  🎯 Closest family match: "${closestFamily}" (diff: ${smallestDiff})`)
            
            const { data, error } = await supabase
              .from('coatings')
              .select('*')
              .eq('family', closestFamily)
              .limit(1)
            
            if (!error && data && data.length > 0) {
              console.log(`  ✅ Found similar product for ${code}: ${data[0].Product_Name || data[0].family}`)
              console.log(`  ℹ️ Note: Using "${closestFamily}" as substitute for "${code}"`)
              matchedProducts.push(cleanProductData(data[0]))
              found = true
              continue
            }
          }
        }
      }
      
      // ============================================================================
      // METHOD 3: SKU Match
      // ============================================================================
      if (!found) {
        console.log(`  🔍 Trying SKU match for ${code}...`)
        
        const skuMatches = cache.skus.filter(s => 
          s.toUpperCase().includes(code.toUpperCase()) ||
          code.toUpperCase().includes(s.toUpperCase())
        )
        
        if (skuMatches.length > 0) {
          console.log(`  📋 Found ${skuMatches.length} SKU matches:`, skuMatches.slice(0, 5))
          
          const { data, error } = await supabase
            .from('coatings')
            .select('*')
            .eq('sku', skuMatches[0])
            .limit(1)
          
          if (!error && data && data.length > 0) {
            console.log(`  ✅ Found product by SKU for ${code}: ${data[0].Product_Name || data[0].family}`)
            matchedProducts.push(cleanProductData(data[0]))
            found = true
            continue
          }
        }
      }
      
      // ============================================================================
      // METHOD 4: Product_Name Search
      // ============================================================================
      if (!found) {
        console.log(`  🔍 Trying Product_Name search for ${code}...`)
        
        const { data, error } = await supabase
          .from('coatings')
          .select('*')
          .ilike('Product_Name', `%${code}%`)
          .limit(1)
        
        if (!error && data && data.length > 0) {
          console.log(`  ✅ Found product by name for ${code}: ${data[0].Product_Name}`)
          matchedProducts.push(cleanProductData(data[0]))
          found = true
          continue
        }
      }
      
      // ============================================================================
      // NOT FOUND
      // ============================================================================
      if (!found) {
        console.log(`  ❌ No match found for ${code}`)
        notFoundCodes.push(code)
      }
    }
    
    console.log(`✅ Total matched products: ${matchedProducts.length}`)
    console.log(`❌ Not found: ${notFoundCodes.length}`, notFoundCodes)
    
    // ============================================================================
    // RETURN RESULTS
    // ============================================================================
    
    if (matchedProducts.length === 0) {
      return NextResponse.json({
        success: false,
        error: `Could not find any products to compare. None of the requested products were found: ${productCodes.join(', ')}`,
        notFound: notFoundCodes,
        results: []
      })
    }
    
    if (matchedProducts.length === 1) {
      console.log('⚠️ Only found 1 product - suggesting similar products')
      
      // Get similar products from the same family or type
      const foundProduct = matchedProducts[0]
      const family = foundProduct.family
      const productType = foundProduct.Product_Type
      
      console.log(`  🔍 Looking for similar products to ${foundProduct.Product_Name}`)
      console.log(`  📋 Family: ${family}, Type: ${productType}`)
      
      // Find similar products
      let similarQuery = supabase
        .from('coatings')
        .select('*')
        .limit(5)
      
      if (family) {
        similarQuery = similarQuery.eq('family', family)
      } else if (productType) {
        similarQuery = similarQuery.eq('Product_Type', productType)
      }
      
      const { data: similarProducts } = await similarQuery
      
      if (similarProducts && similarProducts.length > 1) {
        const cleanedSimilar = similarProducts.slice(0, 2).map(cleanProductData)
        matchedProducts.push(...cleanedSimilar.filter(p => p.sku !== foundProduct.sku))
        
        console.log(`  ✅ Added ${matchedProducts.length - 1} similar products for comparison`)
      }
    }
    
    if (matchedProducts.length < 2) {
      return NextResponse.json({
        success: false,
        error: `Could not find enough products to compare. Found ${matchedProducts.length} of ${productCodes.length} requested.`,
        notFound: notFoundCodes,
        results: matchedProducts,
        suggestion: matchedProducts.length === 1 
          ? `We found "${matchedProducts[0].Product_Name}" but couldn't find "${notFoundCodes[0]}". Try searching for similar product codes.`
          : undefined
      })
    }
    
	console.log('🤖 Generating comparison analysis...')
	
	const comparisonAnalysis = await generateComparisonAnalysis(matchedProducts, query)

	// ✅ UPDATED: Provide both full fields and difference-only fields
	return NextResponse.json({
	  success: true,
	  questionType: 'comparison',
	  intent: 'comparison',
	  comparison: {
		products: matchedProducts,
		summary: comparisonAnalysis,
		comparedFields: getComparedFields(matchedProducts, true), 
		allFields: getComparedFields(matchedProducts, false)        
	  },
	  results: matchedProducts,
	  aiAnswer: comparisonAnalysis,
	  notFound: notFoundCodes.length > 0 ? notFoundCodes : undefined,
	  warning: notFoundCodes.length > 0 
		? `Note: Could not find exact matches for: ${notFoundCodes.join(', ')}. Showing similar products instead.`
		: undefined
	})
    
  } catch (error) {
    console.error('❌ Error in comparison handler:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to generate comparison',
      results: []
    }, { status: 500 })
  }
}

async function handleSKUComparisonQuery(query: string, skus: string[]): Promise<NextResponse> {
  console.log('🎯 Processing SKU comparison for:', skus)
  
  try {
    const matchedProducts: ProductRecord[] = []
    
    for (const sku of skus) {
      const { data, error } = await supabase
        .from('coatings')
        .select('*')
        .eq('sku', sku)
        .limit(1)
      
      if (!error && data && data.length > 0) {
        console.log(`  ✅ Found product for SKU ${sku}`)
        matchedProducts.push(cleanProductData(data[0]))
      }
    }
    
    if (matchedProducts.length < 2) {
      return NextResponse.json({
        success: false,
        error: `Could not find enough products to compare. Found ${matchedProducts.length} of ${skus.length} requested.`,
        results: matchedProducts
      })
    }
    
    const comparisonAnalysis = await generateComparisonAnalysis(matchedProducts, query)
    
    return NextResponse.json({
      success: true,
      questionType: 'comparison',
      intent: 'comparison',
      comparison: {
        products: matchedProducts,
        summary: comparisonAnalysis,
        comparedFields: getComparedFields(matchedProducts)
      },
      results: matchedProducts,
      aiAnswer: comparisonAnalysis
    })
    
  } catch (error) {
    console.error('❌ Error in SKU comparison handler:', error)
    return NextResponse.json({
      success: false,
      error: 'Failed to generate comparison',
      results: []
    })
  }
}

// ============================================================================
// DIVERSIFICATION
// ============================================================================

function diversifyByFamily(products: any[], maxPerFamily: number = Infinity, maxTotal: number = 500): any[] {
  const familyGroups = new Map<string, any[]>()
  
  products.forEach(product => {
    const family = (product.family || 'UNKNOWN').toUpperCase()
    if (!familyGroups.has(family)) {
      familyGroups.set(family, [])
    }
    familyGroups.get(family)!.push(product)
  })
  
  console.log(`📊 Found ${familyGroups.size} unique families`)
  
  const diversified: any[] = []
  const familyNames = Array.from(familyGroups.keys())
  const familyCounters = new Map<string, number>()
  familyNames.forEach(f => familyCounters.set(f, 0))
  
  let roundNumber = 0
  const minPerFamily = 1
  
  while (diversified.length < maxTotal && roundNumber < minPerFamily) {
    let addedInRound = false
    
    for (const family of familyNames) {
      if (diversified.length >= maxTotal) break
      
      const products = familyGroups.get(family)!
      const count = familyCounters.get(family) || 0
      
      if (count < products.length && count < maxPerFamily) {
        diversified.push(products[count])
        familyCounters.set(family, count + 1)
        addedInRound = true
      }
    }
    
    roundNumber++
    if (!addedInRound) break
  }
  
  while (diversified.length < maxTotal) {
    let addedInRound = false
    
    for (const family of familyNames) {
      if (diversified.length >= maxTotal) break
      
      const products = familyGroups.get(family)!
      const count = familyCounters.get(family) || 0
      
      if (count < products.length && count < maxPerFamily) {
        diversified.push(products[count])
        familyCounters.set(family, count + 1)
        addedInRound = true
      }
    }
    
    if (!addedInRound) break
  }
  
  console.log(`✅ Diversified to ${diversified.length} products (round-robin across ALL families)`)
  console.log(`📊 Products per family:`)
  
  const distribution = Array.from(familyCounters.entries())
    .filter(([_, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  
  distribution.slice(0, 30).forEach(([family, count]) => {
    console.log(`  ${family}: ${count} products`)
  })
  
  if (distribution.length > 30) {
    console.log(`  ... and ${distribution.length - 30} more families`)
  }
  
  return diversified
}

// ============================================================================
// FILTER OPTIONS HANDLER
// ============================================================================

async function getFilterOptions(forceRefresh: boolean = false): Promise<any> {
  console.log(`\n📋 Getting filter options (forceRefresh: ${forceRefresh})`)

  if (!forceRefresh && filterCache) {
    const now = Date.now()
    const cacheAge = now - filterCache.timestamp

    if (cacheAge < CACHE_TTL) {
      const ageMinutes = Math.floor(cacheAge / 1000 / 60)
      console.log(`✅ Using cached filter options (age: ${ageMinutes} minutes)`)
      return {
        success: true,
        cached: true,
        cacheAge: ageMinutes,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }

    console.log(`⚠️ Cache expired (age: ${Math.floor(cacheAge / 1000 / 60)} minutes)`)
  }

  console.log(`🔄 Fetching fresh filter options from database...`)
  const startTime = Date.now()

  try {
    console.log('📊 Step 1: Counting total rows...')
    
    const { count: totalCount, error: countError } = await supabase
      .from('coatings')
      .select('*', { count: 'exact', head: true })
    
    if (countError) {
      console.error('❌ Count error:', countError)
      throw new Error(`Count error: ${countError.message}`)
    }
    
    console.log(`📊 Total rows in database: ${totalCount}`)
    
    const BATCH_SIZE = 1000
    const totalBatches = Math.ceil((totalCount || 0) / BATCH_SIZE)
    
    console.log(`📊 Step 2: Fetching ${totalBatches} batches of ${BATCH_SIZE} rows each...`)
    
    const allFamilies: string[] = []
    const allTypes: string[] = []
    const allModels: string[] = []
    
    for (let i = 0; i < totalBatches; i++) {
      const from = i * BATCH_SIZE
      const to = from + BATCH_SIZE - 1
      
      if (i % 5 === 0 || i === totalBatches - 1) {
        console.log(`   Fetching batch ${i + 1}/${totalBatches} (rows ${from}-${to})...`)
      }
      
      const [familiesResult, typesResult, modelsResult] = await Promise.all([
        supabase
          .from('coatings')
          .select('family')
          .not('family', 'is', null)
          .neq('family', '')
          .range(from, to),
        
        supabase
          .from('coatings')
          .select('Product_Type')
          .not('Product_Type', 'is', null)
          .neq('Product_Type', '')
          .range(from, to),
        
        supabase
          .from('coatings')
          .select('Product_Model')
          .not('Product_Model', 'is', null)
          .neq('Product_Model', '')
          .range(from, to)
      ])

      if (familiesResult.error) throw new Error(`Families: ${familiesResult.error.message}`)
      if (typesResult.error) throw new Error(`Types: ${typesResult.error.message}`)
      if (modelsResult.error) throw new Error(`Models: ${modelsResult.error.message}`)

      allFamilies.push(...(familiesResult.data?.map(r => r.family).filter(v => v && v.trim()) || []))
      allTypes.push(...(typesResult.data?.map(r => r.Product_Type).filter(v => v && v.trim()) || []))
      allModels.push(...(modelsResult.data?.map(r => r.Product_Model).filter(v => v && v.trim()) || []))
    }

    console.log(`📊 Raw data collected:`)
    console.log(`   - Families: ${allFamilies.length} values`)
    console.log(`   - Types: ${allTypes.length} values`)
    console.log(`   - Models: ${allModels.length} values`)

    const families = [...new Set(allFamilies)].sort()
    const productTypes = [...new Set(allTypes)].sort()
    const productModels = [...new Set(allModels)].sort()

    filterCache = {
      families,
      productTypes,
      productModels,
      timestamp: Date.now(),
      ttl: CACHE_TTL
    }

    const loadTime = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n✅ Filter options loaded in ${loadTime}s:`)
    console.log(`   👨‍👩‍👧‍👦 Families: ${families.length}`)
    console.log(`   🏷️  Product Types: ${productTypes.length}`)
    console.log(`   📦 Product Models: ${productModels.length}`)
    
    if (families.length > 0) {
      console.log(`   Sample families (first 10):`, families.slice(0, 10))
    }

    return {
      success: true,
      cached: false,
      loadTime: `${loadTime}s`,
      totalRows: totalCount,
      filterOptions: {
        families,
        productTypes,
        productModels
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)

    if (filterCache) {
      console.log('⚠️ Returning expired cache as fallback')
      return {
        success: true,
        cached: true,
        expired: true,
        error: error.message,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }

    return {
      success: false,
      error: error.message || 'Failed to fetch filter options',
      filterOptions: { 
        families: [], 
        productTypes: [], 
        productModels: [] 
      }
    }
  }
}

// ============================================================================
// MAIN POST HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, filters, getFilterOptions: shouldGetFilters } = body

    console.log('📥 Request:', { query, filters, getFilterOptions: shouldGetFilters })

    if (query === '__REFRESH_CACHE__') {
      await refreshCache()
      return NextResponse.json({
        success: true,
        message: 'Cache refreshed successfully',
        cache: productCache
      })
    }

    if (shouldGetFilters === true || query === '__GET_FILTER_OPTIONS__') {
      console.log('📊 Filter options requested')
      
      try {
        const result = await getFilterOptions(false)
        console.log('✅ Returning filter options:', {
          success: result.success,
          familyCount: result.filterOptions.families.length,
          typeCount: result.filterOptions.productTypes.length,
          modelCount: result.filterOptions.productModels.length
        })
        return NextResponse.json(result)
      } catch (error: any) {
        console.error('❌ Filter options error:', error)
        return NextResponse.json(
          { 
            success: false,
            error: error.message || 'Failed to load filter options',
            filterOptions: {
              families: [],
              productTypes: [],
              productModels: []
            }
          },
          { status: 500 }
        )
      }
    }

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json({ 
        success: false,
        error: 'Query is required' 
      }, { status: 400 })
    }

    console.log('\n' + '='.repeat(80))
    console.log('🔍 Search Query:', query)
    console.log('='.repeat(80))

    // ============================================================================
    // STEP 0: SKU ANALYSIS & META QUESTIONS
    // ============================================================================

    if (detectSKUAnalysisQuery(query)) {
      console.log('🎯 Detected SKU analysis query')
      const result = await analyzeSKUs(query)
      return NextResponse.json(result)
    }

    const metaQuestion = detectMetaQuestion(query)
    if (metaQuestion.isMeta && metaQuestion.type) {
      console.log(`🎯 Detected meta-question type: ${metaQuestion.type}`)
      const result = await handleMetaQuestion(metaQuestion.type, query, filters)
      if (result) {
        return NextResponse.json(result)
      }
    }

    // ============================================================================
    // STEP 1: INITIALIZE SEARCH VARIABLES
    // ============================================================================

    const comparison = extractComparisonProducts(query)
    const intent = classifyIntent(query)
    const expandedTerms = expandSearchTerms(query)

    console.log(`🎯 Intent: ${intent.intent} (${intent.confidence})`)

    if (comparison.isComparison) {
      console.log('🔍 Comparison detection summary:')
      console.log(`   - Product codes found: ${comparison.productCodes.length}`, comparison.productCodes)
      console.log(`   - Potential SKUs found: ${comparison.potentialSkus.length}`, comparison.potentialSkus)
    } else {
      console.log('ℹ️ Not detected as comparison query')
    }

    // ============================================================================
    // STEP 2: COMPARISON QUERIES (HIGHEST PRIORITY)
    // ============================================================================

    console.log('🔍 Checking for comparison patterns...')

    // Pattern-based detection (simple regex patterns)
    const comparisonPatterns = [
      /compare\s+([a-z0-9\-]+)\s+(?:to|vs|versus|and|with)\s+([a-z0-9\-]+)/i,
      /([a-z0-9\-]+)\s+vs\s+([a-z0-9\-]+)/i,
      /difference between\s+([a-z0-9\-]+)\s+and\s+([a-z0-9\-]+)/i
    ]

    for (const pattern of comparisonPatterns) {
      const match = query.match(pattern)
      if (match) {
        const productCodes = [match[1], match[2]]
        console.log('🎯 Detected comparison query via pattern')
        console.log('🎯 Product codes:', productCodes)
        return await handleComparisonQuery(query, productCodes)
      }
    }

    // Extraction-based detection
    if (comparison.isComparison && comparison.productCodes.length >= 2) {
      console.log('🎯 Detected comparison query via extraction')
      console.log('🎯 Product codes:', comparison.productCodes)
      return await handleComparisonQuery(query, comparison.productCodes)
    }

    if (comparison.isComparison && comparison.potentialSkus.length >= 2) {
      console.log('🎯 Detected SKU comparison query')
      console.log('🎯 SKUs:', comparison.potentialSkus)
      return await handleSKUComparisonQuery(query, comparison.potentialSkus)
    }

    // ============================================================================
    // STEP 3: EXACT MATCH SEARCH
    // ============================================================================

    if (!comparison.isComparison) {
      const bestMatch = await findBestMatch(query)

      if (bestMatch.matched && bestMatch.confidence >= 0.95) {
        console.log(`🎯 Using exact match: ${bestMatch.field} = "${bestMatch.value}"`)
        
        let dbQuery = supabase.from('coatings').select('*')
        
        switch (bestMatch.field) {
          case 'family':
            dbQuery = dbQuery.eq('family', bestMatch.value)
            break
          case 'sku':
            dbQuery = dbQuery.eq('sku', bestMatch.value)
            break
          case 'productType':
            dbQuery = dbQuery.eq('Product_Type', bestMatch.value)
            break
          case 'productModel':
            dbQuery = dbQuery.eq('Product_Model', bestMatch.value)
            break
        }
        
        dbQuery = dbQuery.limit(1000)
        
        const { data: matchedProducts, error: matchError } = await dbQuery
        
        if (matchError) {
          console.error('❌ Exact match query error:', matchError)
        } else if (matchedProducts && matchedProducts.length > 0) {
          console.log(`✅ Found ${matchedProducts.length} products via exact match`)
          
          let cleanedProducts = matchedProducts.map(cleanProductData)
          let diversifiedResults = diversifyByFamily(cleanedProducts, Infinity, 500)
          
          diversifiedResults = diversifiedResults.map((p, index) => ({
            ...p,
            _relevanceScore: scoreProductRelevance(p, expandedTerms, index === 0)
          }))

          diversifiedResults.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0))

          console.log(`🏆 Top 10 diversified results:`)
          diversifiedResults.slice(0, 10).forEach((p, i) => {
            const baseCode = (p.Product_Name || '')
              .match(/\b([A-Z]{2,}\s*\d+[A-Z]?)/i)?.[0] || '?'
            console.log(`  ${i + 1}. [${baseCode}] ${p.Product_Name} (score: ${p._relevanceScore})`)
          })

          // ✅ Fallback comparison check
          if (query.toLowerCase().includes('compare') && diversifiedResults.length >= 2) {
            console.log('🎯 Fallback comparison: Detected comparison intent')
            
            const topProducts = diversifiedResults.slice(0, Math.min(10, diversifiedResults.length))
            const comparisonAnalysis = await generateComparisonAnalysis(topProducts, query)
            
			  return NextResponse.json({
				success: true,
				questionType: 'comparison',
				intent: 'comparison',
				comparison: {
				  products: topProducts,
				  summary: comparisonAnalysis,
				  comparedFields: getComparedFields(topProducts, true),  
				  allFields: getComparedFields(topProducts, false) 
				},
				summary: comparisonAnalysis,
				aiAnswer: comparisonAnalysis,
				results: topProducts,
				totalResults: topProducts.length,
				displayedResults: topProducts.length,
				count: topProducts.length,
				matchedField: bestMatch.field,
				matchedValue: bestMatch.value,
				confidence: bestMatch.confidence
			  })
			}

          const summary = await generateAISummary(query, diversifiedResults)

          return NextResponse.json({
            success: true,
            questionType: 'search',
            summary: summary,
            aiAnswer: summary,
            results: diversifiedResults.slice(0, 50),
            totalResults: diversifiedResults.length,
            count: diversifiedResults.length,
            displayedResults: Math.min(50, diversifiedResults.length),
            matchedField: bestMatch.field,
            matchedValue: bestMatch.value,
            confidence: bestMatch.confidence
          })
        }
      }
    }
    
    // ============================================================================
    // USE SEMANTIC SEARCH FOR GENERAL QUERIES
    // ============================================================================
    
    console.log('🧠 Using semantic search for general query...')
    
    let results: any[] = []
    
    try {
      results = await semanticSearch(query, 150)
      
      if (results.length > 0) {
        console.log(`✅ Semantic search returned ${results.length} results`)
        
        let cleanedProducts = results.map(cleanProductData)
        
        let diversifiedResults = diversifyByFamily(cleanedProducts, 20, 100)
        
        diversifiedResults = diversifiedResults.map(p => ({
          ...p,
          _relevanceScore: scoreProductRelevance(p, expandedTerms)
        }))
        
        diversifiedResults.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0))
        
        console.log(`🏆 Top 10 semantic results:`)
        diversifiedResults.slice(0, 10).forEach((p, i) => {
          const baseCode = (p.Product_Name || '')
            .match(/\b([A-Z]{2,}\s*\d+[A-Z]?)/i)?.[0] || '?'
          console.log(`  ${i + 1}. [${baseCode}] ${p.Product_Name} (score: ${p._relevanceScore})`)
        })
        
        const aiAnswer = await generateAISummary(query, diversifiedResults)
        
        return NextResponse.json({
          success: true,
          questionType: 'search',
          summary: aiAnswer,
          aiAnswer: aiAnswer,
          results: diversifiedResults.slice(0, 50),
          totalResults: diversifiedResults.length,
          count: diversifiedResults.length,
          displayedResults: Math.min(50, diversifiedResults.length),
          searchMethod: 'semantic'
        })
      }
    } catch (error) {
      console.error('⚠️ Semantic search failed, falling back to traditional search')
    }
    
    // ============================================================================
    // FALLBACK: TRADITIONAL SEARCH
    // ============================================================================
    
    console.log('🔍 Falling back to traditional search...')
    console.log(`🔄 Expanded terms:`, expandedTerms)

    let allResults: any[] = []
    const searchTerms = expandedTerms.slice(0, 40)

    const typeQuery = supabase
      .from('coatings')
      .select('*')
      .or(searchTerms.map(term => `Product_Type.ilike.%${term}%`).join(','))

    const { data: typeData } = await typeQuery
    console.log(`  📦 Found ${typeData?.length || 0} products by Product_Type`)

    if (typeData) allResults.push(...typeData)

    if (typeData && typeData.length > 0) {
      const uniqueFamilies = [...new Set(typeData.map(p => p.family).filter(Boolean))]
      console.log(`  📋 Found ${uniqueFamilies.length} unique families:`, uniqueFamilies.slice(0, 10))
      
      if (uniqueFamilies.length > 0) {
        const familyQuery = supabase
          .from('coatings')
          .select('*')
          .in('family', uniqueFamilies)
        
        const { data: familyData } = await familyQuery
        console.log(`  📦 Found ${familyData?.length || 0} products by family codes`)
        
        if (familyData) allResults.push(...familyData)
      }
    }

    const nameQuery = supabase
      .from('coatings')
      .select('*')
      .or(searchTerms.map(term => `Product_Name.ilike.%${term}%`).join(','))

    const { data: nameData } = await nameQuery
    console.log(`  📦 Found ${nameData?.length || 0} products by Product_Name`)

    if (nameData) allResults.push(...nameData)

    const descQuery = supabase
      .from('coatings')
      .select('*')
      .or(searchTerms.map(term => `Product_Description.ilike.%${term}%`).join(','))

    const { data: descData } = await descQuery
    console.log(`  📦 Found ${descData?.length || 0} products by Product_Description`)

    if (descData) allResults.push(...descData)

    const skuQuery = supabase
      .from('coatings')
      .select('*')
      .or(searchTerms.map(term => `sku.ilike.%${term}%`).join(','))

    const { data: skuData } = await skuQuery
    console.log(`  📦 Found ${skuData?.length || 0} products by SKU`)

    if (skuData) allResults.push(...skuData)

    const uniqueMap = new Map<string, any>()

    allResults.forEach(product => {
      const key = product.sku || product.Product_Name || Math.random().toString()
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, product)
      }
    })

    const uniqueResults = Array.from(uniqueMap.values())

    console.log(`✅ Total unique products: ${uniqueResults.length}`)

    if (uniqueResults.length === 0) {
      return NextResponse.json({
        success: true,
        questionType: 'search',
        summary: 'No products found. Try adjusting your search terms or using different keywords.',
        aiAnswer: 'No products found. Try adjusting your search terms or using different keywords.',
        results: [],
        count: 0
      })
    }

    let diversifiedResults = diversifyByFamily(uniqueResults, Infinity, 500)

    diversifiedResults = diversifiedResults.map(cleanProductData)

    diversifiedResults = diversifiedResults.map(p => ({
      ...p,
      _relevanceScore: scoreProductRelevance(p, expandedTerms)
    }))
    
    diversifiedResults.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0))
    
    console.log('🏆 Top 10 results:')
    diversifiedResults.slice(0, 10).forEach((p, i) => {
      const baseCode = (p.Product_Name || '')
        .match(/\b([A-Z]{2,}\s*\d+[A-Z]?)/i)?.[0] || '?'
      console.log(`  ${i + 1}. [${baseCode}] ${p.Product_Name} (score: ${p._relevanceScore})`)
    })

    const aiAnswer = await generateAISummary(query, diversifiedResults)

    return NextResponse.json({
      success: true,
      questionType: 'search',
      summary: aiAnswer,
      aiAnswer: aiAnswer,
      results: diversifiedResults.slice(0, 50),
      totalResults: diversifiedResults.length,
      count: diversifiedResults.length,
      displayedResults: Math.min(50, diversifiedResults.length),
      searchMethod: 'traditional'
    })

  } catch (error: any) {
    console.error('❌ Error in POST handler:', error)
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'An error occurred while processing your request',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

// ============================================================================
// GET HANDLER (for testing)
// ============================================================================

export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: 'ok',
    message: 'Coatings Smart Search API with Semantic Search',
    version: '2.0',
    features: [
      'Semantic search with vector embeddings',
      'Traditional keyword search fallback',
      'Product comparison',
      'Meta-question handling',
      'SKU analysis (missing/duplicate)',
      'Filter options',
      'AI-powered summaries',
      'Family-based diversification'
    ],
    endpoints: {
      POST: 'Search for products',
      GET: 'API status'
    }
  })
}
